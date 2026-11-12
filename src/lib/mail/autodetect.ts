import "server-only";
import { resolveMx } from "node:dns/promises";

export interface ServerSettings {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** How the settings were found, shown on the status page. */
  source: string;
}

/** Providers keyed by email domain or by the domain their MX records point at. */
const KNOWN: Record<string, Omit<ServerSettings, "source">> = {
  "privateemail.com": { imapHost: "mail.privateemail.com", imapPort: 993, smtpHost: "mail.privateemail.com", smtpPort: 465 },
  "gmail.com": { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465 },
  "googlemail.com": { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465 },
  "google.com": { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465 },
  "fastmail.com": { imapHost: "imap.fastmail.com", imapPort: 993, smtpHost: "smtp.fastmail.com", smtpPort: 465 },
  "messagingengine.com": { imapHost: "imap.fastmail.com", imapPort: 993, smtpHost: "smtp.fastmail.com", smtpPort: 465 },
  "icloud.com": { imapHost: "imap.mail.me.com", imapPort: 993, smtpHost: "smtp.mail.me.com", smtpPort: 587 },
  "me.com": { imapHost: "imap.mail.me.com", imapPort: 993, smtpHost: "smtp.mail.me.com", smtpPort: 587 },
  "outlook.com": { imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp-mail.outlook.com", smtpPort: 587 },
  "hotmail.com": { imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp-mail.outlook.com", smtpPort: 587 },
  "yahoo.com": { imapHost: "imap.mail.yahoo.com", imapPort: 993, smtpHost: "smtp.mail.yahoo.com", smtpPort: 465 },
  "zoho.com": { imapHost: "imap.zoho.com", imapPort: 993, smtpHost: "smtp.zoho.com", smtpPort: 465 },
};

const cache = new Map<string, Promise<ServerSettings>>();

/** Strips subdomains: "mx1.privateemail.com" -> "privateemail.com". Good enough for MX hosts. */
function baseDomain(host: string) {
  return host.toLowerCase().replace(/\.$/, "").split(".").slice(-2).join(".");
}

function matchKnown(domain: string): Omit<ServerSettings, "source"> | undefined {
  return KNOWN[domain] ?? KNOWN[baseDomain(domain)];
}

/** Mozilla's ISPDB, the database Thunderbird uses to set up accounts. */
async function fromIspdb(domain: string): Promise<Omit<ServerSettings, "source"> | undefined> {
  try {
    const res = await fetch(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return undefined;
    const xml = await res.text();
    const server = (type: "imap" | "smtp") => {
      const tag = type === "imap" ? "incomingServer" : "outgoingServer";
      const blocks = [...xml.matchAll(new RegExp(`<${tag} type="${type}">([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
      // Prefer implicit TLS (SSL); fall back to the first entry.
      const block = blocks.find((b) => /<socketType>SSL<\/socketType>/.test(b)) ?? blocks[0];
      if (!block) return undefined;
      const host = block.match(/<hostname>([^<]+)<\/hostname>/)?.[1];
      const port = Number(block.match(/<port>(\d+)<\/port>/)?.[1]);
      return host && port ? { host: host.replace("%EMAILDOMAIN%", domain), port } : undefined;
    };
    const imap = server("imap");
    const smtp = server("smtp");
    if (!imap) return undefined;
    return { imapHost: imap.host, imapPort: imap.port, smtpHost: smtp?.host ?? imap.host, smtpPort: smtp?.port ?? 465 };
  } catch {
    return undefined;
  }
}

async function detect(email: string): Promise<ServerSettings> {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) throw new Error(`"${email}" is not an email address`);

  const known = matchKnown(domain);
  if (known) return { ...known, source: "built-in provider list" };

  const ispdb = await fromIspdb(domain);
  if (ispdb) return { ...ispdb, source: "Mozilla ISPDB" };

  // Custom domain: look at where its mail is delivered (e.g. mx1.privateemail.com).
  try {
    const mx = (await resolveMx(domain)).sort((a, b) => a.priority - b.priority)[0]?.exchange;
    if (mx) {
      const mxDomain = baseDomain(mx);
      const byMx = matchKnown(mxDomain) ?? (await fromIspdb(mxDomain));
      if (byMx) return { ...byMx, source: `MX record (${mx})` };
    }
  } catch {
    // fall through
  }

  return { imapHost: `mail.${domain}`, imapPort: 993, smtpHost: `mail.${domain}`, smtpPort: 465, source: "guess (mail.<domain>)" };
}

export function detectServers(email: string): Promise<ServerSettings> {
  const key = email.toLowerCase();
  let p = cache.get(key);
  if (!p) {
    p = detect(key);
    cache.set(key, p);
  }
  return p;
}
