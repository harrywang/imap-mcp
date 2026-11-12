import "server-only";
import { ImapFlow, type ListResponse, type SearchObject } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { getMailAccounts, type MailAccountConfig } from "../config";
import { detectServers, type ServerSettings } from "./autodetect";

export interface ResolvedAccount extends MailAccountConfig {
  servers: ServerSettings;
}

export async function resolveAccount(account: MailAccountConfig): Promise<ResolvedAccount> {
  const detected = await detectServers(account.email);
  const overridden = Boolean(account.imapHost || account.smtpHost);
  return {
    ...account,
    servers: {
      imapHost: account.imapHost ?? detected.imapHost,
      imapPort: account.imapPort ?? (account.imapHost ? 993 : detected.imapPort),
      smtpHost: account.smtpHost ?? detected.smtpHost,
      smtpPort: account.smtpPort ?? (account.smtpHost ? 465 : detected.smtpPort),
      source: overridden ? "MAIL_n_*_HOST env vars" : detected.source,
    },
  };
}

/**
 * Finds an account by name, email or slot number. No selector means the first account, unless
 * `explicit` is set and several mailboxes exist: UIDs are only meaningful inside one mailbox, and
 * writes must come from the right address, so those calls have to name the mailbox.
 */
export async function getAccount(selector?: string, opts: { explicit?: boolean } = {}): Promise<ResolvedAccount> {
  const accounts = getMailAccounts();
  if (accounts.length === 0) throw new Error("No mailbox configured (set MAIL_1 and MAIL_1_PASSWORD).");
  if (!selector?.trim()) {
    if (opts.explicit && accounts.length > 1) {
      throw new Error(
        `Several mailboxes are configured (${accounts.map((a) => a.email).join(", ")}). ` +
          "Pass `account` to say which one. Use the mailbox the message was read from; " +
          "if it isn't clear which mailbox the user means, ask them instead of guessing.",
      );
    }
    return resolveAccount(accounts[0]);
  }
  const s = selector.trim().toLowerCase();
  const match = accounts.find(
    (a) => a.email.toLowerCase() === s || a.name.toLowerCase() === s || String(a.slot) === s,
  );
  if (!match) {
    throw new Error(`Unknown account "${selector}". Available: ${accounts.map((a) => a.email).join(", ")}`);
  }
  return resolveAccount(match);
}

async function withImap<T>(account: ResolvedAccount, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const { imapHost, imapPort } = account.servers;
  const client = new ImapFlow({
    host: imapHost,
    port: imapPort,
    secure: imapPort === 993,
    auth: { user: account.username, pass: account.password },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

async function inFolder<T>(account: ResolvedAccount, folder: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  return withImap(account, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      return await fn(c);
    } finally {
      lock.release();
    }
  });
}

async function findSpecialFolder(c: ImapFlow, use: "\\Drafts" | "\\Sent", fallbacks: string[]): Promise<string> {
  const folders = await c.list();
  const bySpecial = folders.find((f) => f.specialUse === use);
  if (bySpecial) return bySpecial.path;
  const byName = folders.find((f) => fallbacks.some((n) => f.path.toLowerCase() === n.toLowerCase() || f.name.toLowerCase() === n.toLowerCase()));
  if (byName) return byName.path;
  throw new Error(`Could not find a ${use.slice(1)} folder. Folders: ${folders.map((f) => f.path).join(", ")}`);
}

const addr = (a?: AddressObject | AddressObject[]) =>
  a ? (Array.isArray(a) ? a.map((x) => x.text).join(", ") : a.text) : undefined;

const htmlToText = (html: string) =>
  html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// ---------- operations used by the MCP tools ----------

/** Lightweight connection check for the status page. */
export async function testImap(account: ResolvedAccount): Promise<{ ok: boolean; detail: string }> {
  try {
    const status = await withImap(account, (c) => c.status("INBOX", { messages: true, unseen: true }));
    if (!status) return { ok: true, detail: "Connected" };
    return { ok: true, detail: `${status.messages ?? 0} messages, ${status.unseen ?? 0} unread in INBOX` };
  } catch (e) {
    return { ok: false, detail: (e as Error & { responseText?: string }).responseText || (e as Error).message };
  }
}

export async function listFolders(account: ResolvedAccount) {
  return withImap(account, async (c) => {
    const folders: ListResponse[] = await c.list();
    return folders.map((f) => ({ path: f.path, specialUse: f.specialUse || undefined }));
  });
}

export interface SearchParams {
  folder: string;
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  since?: string;
  before?: string;
  unreadOnly?: boolean;
  limit: number;
}

export async function searchEmails(account: ResolvedAccount, p: SearchParams) {
  return inFolder(account, p.folder, async (c) => {
    const query: SearchObject = {};
    if (p.text) query.text = p.text;
    if (p.from) query.from = p.from;
    if (p.to) query.to = p.to;
    if (p.subject) query.subject = p.subject;
    if (p.since) query.since = new Date(p.since);
    if (p.before) query.before = new Date(p.before);
    if (p.unreadOnly) query.seen = false;
    if (Object.keys(query).length === 0) query.all = true;

    const uids = (await c.search(query, { uid: true })) || [];
    const total = uids.length;
    const pick = uids.sort((a, b) => a - b).slice(-p.limit);
    const results = [];
    if (pick.length) {
      for await (const m of c.fetch(pick, { envelope: true, flags: true, size: true }, { uid: true })) {
        results.push({
          uid: m.uid,
          date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : undefined,
          from: m.envelope?.from?.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", "),
          to: m.envelope?.to?.map((a) => a.address).join(", "),
          subject: m.envelope?.subject,
          unread: !m.flags?.has("\\Seen"),
          size: m.size,
        });
      }
    }
    results.sort((a, b) => b.uid - a.uid); // newest first
    return { folder: p.folder, totalMatches: total, returned: results.length, messages: results };
  });
}

export async function readEmail(account: ResolvedAccount, folder: string, uid: number, maxChars: number) {
  return inFolder(account, folder, async (c) => {
    const msg = await c.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
    if (!msg || !msg.source) throw new Error(`No message with UID ${uid} in ${folder}`);
    const p = await simpleParser(msg.source);
    let body = p.text?.trim() || (p.html ? htmlToText(p.html) : "");
    const truncated = body.length > maxChars;
    if (truncated) body = body.slice(0, maxChars);
    return {
      uid,
      folder,
      messageId: p.messageId,
      date: p.date?.toISOString(),
      from: addr(p.from),
      to: addr(p.to),
      cc: addr(p.cc),
      bcc: addr(p.bcc),
      replyTo: addr(p.replyTo),
      subject: p.subject,
      unread: !msg.flags?.has("\\Seen"),
      attachments: p.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
      body,
      truncated,
    };
  });
}

export interface Draft {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  /** The message being replied to. Its Message-ID must match, so a UID from another mailbox can't slip through. */
  replyTo?: { folder: string; uid: number; messageId: string };
}

const normId = (id?: string) => (id ?? "").trim().replace(/^<|>$/g, "");

/**
 * Builds the MIME message, adding In-Reply-To/References when replying so it threads.
 * Throws before anything is saved or sent if the original isn't in this mailbox.
 */
async function compose(account: ResolvedAccount, c: ImapFlow, d: Draft, keepBcc = false) {
  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  let replyingTo: { from?: string; subject?: string; date?: string } | undefined;
  if (d.replyTo) {
    const { folder, uid, messageId } = d.replyTo;
    const lock = await c.getMailboxLock(folder);
    try {
      const orig = await c.fetchOne(String(uid), { source: true }, { uid: true });
      if (!orig || !orig.source) {
        throw new Error(
          `No message with UID ${uid} in ${folder} of ${account.email}. UIDs belong to one mailbox: ` +
            "reply from the mailbox you read the message in.",
        );
      }
      const p = await simpleParser(orig.source);
      if (!p.messageId || normId(p.messageId) !== normId(messageId)) {
        throw new Error(
          `UID ${uid} in ${folder} of ${account.email} is a different message ("${p.subject ?? ""}" from ` +
            `${addr(p.from) ?? "unknown"}). You are probably using a UID from another mailbox. Reply from the ` +
            "mailbox you read the message in; if unsure which, ask the user. Nothing was saved or sent.",
        );
      }
      inReplyTo = p.messageId;
      const prior = typeof p.references === "string" ? [p.references] : p.references ?? [];
      references = [...prior, p.messageId];
      replyingTo = { from: addr(p.from), subject: p.subject, date: p.date?.toISOString() };
    } finally {
      lock.release();
    }
  }
  const mail = {
    from: account.name !== account.email ? `"${account.name}" <${account.email}>` : account.email,
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject,
    text: d.body,
    inReplyTo,
    references,
  };
  const node = new MailComposer(mail).compile();
  // Drafts keep the Bcc header so it shows when you open the draft; sent mail never carries it.
  if (keepBcc) node.keepBcc = true;
  const raw = await node.build();
  return { mail, raw, replyingTo };
}

export async function createDraft(account: ResolvedAccount, d: Draft) {
  return withImap(account, async (c) => {
    const { raw, replyingTo } = await compose(account, c, d, true);
    const drafts = await findSpecialFolder(c, "\\Drafts", ["Drafts", "INBOX.Drafts", "Draft"]);
    const res = await c.append(drafts, raw, ["\\Draft", "\\Seen"]);
    return { from: account.email, savedTo: drafts, uid: res ? res.uid : undefined, replyingTo };
  });
}

export async function sendEmail(account: ResolvedAccount, d: Draft) {
  return withImap(account, async (c) => {
    const { mail, raw, replyingTo } = await compose(account, c, d);
    const { smtpHost, smtpPort } = account.servers;
    const transport = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: account.username, pass: account.password },
    });
    const info = await transport.sendMail({ ...mail, raw });
    // Many IMAP servers don't save SMTP-sent mail; keep a copy in Sent.
    let savedTo: string | undefined;
    try {
      savedTo = await findSpecialFolder(c, "\\Sent", ["Sent", "INBOX.Sent", "Sent Items", "Sent Messages"]);
      await c.append(savedTo, raw, ["\\Seen"]);
    } catch {
      savedTo = undefined;
    }
    return {
      from: account.email,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      copySavedTo: savedTo,
      replyingTo,
    };
  });
}

export async function moveEmail(account: ResolvedAccount, folder: string, uids: number[], destination: string) {
  return inFolder(account, folder, async (c) => {
    const res = await c.messageMove(uids, destination, { uid: true });
    return { moved: uids.length, from: folder, to: destination, result: res ? "ok" : "failed" };
  });
}

export async function setRead(account: ResolvedAccount, folder: string, uids: number[], read: boolean) {
  return inFolder(account, folder, async (c) => {
    const ok = read
      ? await c.messageFlagsAdd(uids, ["\\Seen"], { uid: true })
      : await c.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
    return { updated: uids.length, read, ok };
  });
}
