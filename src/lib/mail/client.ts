import "server-only";
import { ImapFlow, type ListResponse, type SearchObject } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import addressparser from "nodemailer/lib/addressparser";
import { getMailAccounts, type MailAccountConfig } from "../config";
import { detectServers, type ServerSettings } from "./autodetect";
import { checkSendLimit, recordSend } from "./send-limit";

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
    // On other ports, require STARTTLS: fail rather than send the password unencrypted.
    ...(imapPort === 993 ? {} : { doSTARTTLS: true }),
    auth: { user: account.username, pass: account.password },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  // A dropped connection is reported as an "error" event; without a listener Node treats it as an
  // uncaught exception. The failing operation still rejects, so the tool returns a normal error.
  client.on("error", (err) => console.error(`IMAP ${imapHost}: ${err.message}`));
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
  return { mail, raw, replyingTo, messageId: node.messageId() };
}

export async function createDraft(account: ResolvedAccount, d: Draft) {
  return withImap(account, async (c) => {
    const { raw, replyingTo, messageId } = await compose(account, c, d, true);
    const drafts = await findSpecialFolder(c, "\\Drafts", ["Drafts", "INBOX.Drafts", "Draft"]);
    const res = await c.append(drafts, raw, ["\\Draft", "\\Seen"]);
    return {
      savedTo: drafts,
      draftUid: res ? res.uid : undefined,
      draftMessageId: messageId,
      draft: {
        from: account.email,
        to: emails(d.to),
        cc: emails(d.cc),
        bcc: emails(d.bcc),
        subject: d.subject,
        body: d.body,
      },
      replyingTo,
    };
  });
}

/** "Ann <a@x.com>, b@y.com" -> ["a@x.com", "b@y.com"] */
function emails(list?: string): string[] {
  if (!list) return [];
  const flat = (xs: ReturnType<typeof addressparser>): string[] =>
    xs.flatMap((x) => ("group" in x && x.group ? flat(x.group) : x.address ? [x.address] : []));
  return flat(addressparser(list));
}

/** Removes Bcc headers (with folded continuation lines) so recipients never see them. */
function stripBcc(source: Buffer): Buffer {
  const text = source.toString("binary");
  const end = text.search(/\r?\n\r?\n/);
  if (end < 0) return source;
  const headers = text.slice(0, end).split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of headers) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line);
      continue;
    }
    skipping = /^bcc:/i.test(line);
    if (!skipping) kept.push(line);
  }
  return Buffer.from(kept.join("\r\n") + text.slice(end), "binary");
}

const addresses = (a?: AddressObject | AddressObject[]) =>
  (a ? (Array.isArray(a) ? a : [a]) : []).flatMap((x) => x.value.map((v) => v.address).filter(Boolean) as string[]);

/**
 * Sends an existing draft exactly as saved: the one the user was shown. The draft is
 * identified by UID and Message-ID, so a different or edited draft is never sent by mistake.
 */
/** What the user approved. Shown in the client's approval prompt and checked against the draft. */
export interface ApprovedSend {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

/** Compares bodies ignoring only line-ending style and trailing whitespace, which MIME encoding may change. */
const normBody = (t: string) =>
  t
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();

const sameSet = (a: string[], b: string[]) => {
  const norm = (x: string[]) => [...new Set(x.map((v) => v.trim().toLowerCase()).filter(Boolean))].sort().join(",");
  return norm(a) === norm(b);
};

export async function sendDraft(
  account: ResolvedAccount,
  draftUid: number,
  draftMessageId: string,
  approved: ApprovedSend,
) {
  await checkSendLimit(account.email);
  return withImap(account, async (c) => {
    const drafts = await findSpecialFolder(c, "\\Drafts", ["Drafts", "INBOX.Drafts", "Draft"]);
    const lock = await c.getMailboxLock(drafts);
    try {
      const msg = await c.fetchOne(String(draftUid), { source: true }, { uid: true });
      if (!msg || !msg.source) throw new Error(`No draft with UID ${draftUid} in ${drafts} of ${account.email}. Nothing was sent.`);
      const p = await simpleParser(msg.source);
      if (!p.messageId || normId(p.messageId) !== normId(draftMessageId)) {
        throw new Error(
          `Draft ${draftUid} in ${account.email} is not the draft you showed the user (it may have been edited or ` +
            "replaced). Read it again with read_email, show it to the user, and ask again. Nothing was sent.",
        );
      }
      const fromAddrs = addresses(p.from).map((x) => x.toLowerCase());
      if (fromAddrs.length !== 1 || fromAddrs[0] !== account.email.toLowerCase()) {
        throw new Error(`This draft is not from ${account.email}. Nothing was sent.`);
      }
      const actual = { to: addresses(p.to), cc: addresses(p.cc), bcc: addresses(p.bcc), subject: p.subject ?? "" };
      const mismatches = [
        !sameSet(actual.to, approved.to) && `to is ${actual.to.join(", ") || "(none)"}`,
        !sameSet(actual.cc, approved.cc) && `cc is ${actual.cc.join(", ") || "(none)"}`,
        !sameSet(actual.bcc, approved.bcc) && `bcc is ${actual.bcc.join(", ") || "(none)"}`,
        actual.subject.trim() !== approved.subject.trim() && `subject is "${actual.subject}"`,
      ].filter(Boolean);
      const storedBody = p.text ?? (p.html ? htmlToText(p.html) : "");
      if (normBody(storedBody) !== normBody(approved.body)) {
        mismatches.push(`body is:\n---\n${storedBody.trim()}\n---`);
      }
      if (mismatches.length) {
        throw new Error(
          `The draft doesn't match what was approved: its ${mismatches.join("; ")}. Show the user the actual ` +
            "draft and ask again. Nothing was sent.",
        );
      }
      const recipients = [...actual.to, ...actual.cc, ...actual.bcc];
      if (recipients.length === 0) throw new Error("This draft has no recipients. Nothing was sent.");

      const raw = stripBcc(msg.source);
      const { smtpHost, smtpPort } = account.servers;
      const transport = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        // On other ports (e.g. 587), require STARTTLS: fail rather than send the password unencrypted.
        requireTLS: smtpPort !== 465,
        auth: { user: account.username, pass: account.password },
      });
      const info = await transport.sendMail({ envelope: { from: account.email, to: recipients }, raw });
      await recordSend(account.email);

      // Keep a copy in Sent (many servers don't save SMTP-sent mail), then remove the draft.
      let copySavedTo: string | undefined;
      try {
        copySavedTo = await findSpecialFolder(c, "\\Sent", ["Sent", "INBOX.Sent", "Sent Items", "Sent Messages"]);
        await c.append(copySavedTo, raw, ["\\Seen"]);
      } catch {
        copySavedTo = undefined;
      }
      await c.messageDelete(String(draftUid), { uid: true });
      return {
        from: account.email,
        sentTo: recipients,
        subject: p.subject,
        accepted: info.accepted,
        rejected: info.rejected,
        copySavedTo,
        draftRemoved: true,
      };
    } finally {
      lock.release();
    }
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
