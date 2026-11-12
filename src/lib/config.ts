import "server-only";

/** The public origin of this deployment, with no trailing slash. */
export const APP_URL = (
  process.env.APP_URL ||
  process.env.BETTER_AUTH_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000")
).replace(/\/+$/, "");

/** The MCP endpoint. OAuth access tokens are audience-bound to this exact URL. */
export const MCP_URL = `${APP_URL}/api/mcp`;

/** Sending (of drafts the user approved in chat) is on unless ALLOW_SEND=false. */
export const ALLOW_SEND = process.env.ALLOW_SEND !== "false";

export const DATABASE_URL =
  process.env.DATABASE_URL || process.env.POSTGRES_URL || "";

export interface MailAccountConfig {
  /** 1-based slot number from MAIL_<n>. */
  slot: number;
  name: string;
  email: string;
  username: string;
  password: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
}

/**
 * Reads MAIL_1, MAIL_1_PASSWORD, MAIL_2, ... from the environment.
 * Optional per account: MAIL_<n>_NAME, MAIL_<n>_USERNAME, MAIL_<n>_IMAP_HOST,
 * MAIL_<n>_IMAP_PORT, MAIL_<n>_SMTP_HOST, MAIL_<n>_SMTP_PORT.
 */
export function getMailAccounts(): MailAccountConfig[] {
  const accounts: MailAccountConfig[] = [];
  for (let n = 1; n <= 20; n++) {
    const email = process.env[`MAIL_${n}`]?.trim();
    if (!email) continue;
    const env = (k: string) => process.env[`MAIL_${n}_${k}`]?.trim() || undefined;
    const port = (k: string) => (env(k) ? Number(env(k)) : undefined);
    accounts.push({
      slot: n,
      email,
      name: env("NAME") ?? email,
      username: env("USERNAME") ?? email,
      password: process.env[`MAIL_${n}_PASSWORD`] ?? "",
      imapHost: env("IMAP_HOST"),
      imapPort: port("IMAP_PORT"),
      smtpHost: env("SMTP_HOST"),
      smtpPort: port("SMTP_PORT"),
    });
  }
  return accounts;
}

/** Login username. It's only an identifier: no mail is ever sent to it. */
export const DEFAULT_ADMIN_EMAIL = "admin@imap-mcp.local";

/** The single login allowed into this app. */
export function getAdminCredentials() {
  const email = (process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL).trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  return { email, password };
}

/** Problems that stop the app from working, shown on the status page. */
export function getConfigProblems(): string[] {
  const problems: string[] = [];
  if (!DATABASE_URL) problems.push("DATABASE_URL is not set. Connect a Neon database in Vercel → Storage.");
  if (!process.env.BETTER_AUTH_SECRET) problems.push("BETTER_AUTH_SECRET is not set.");
  const admin = getAdminCredentials();
  if (admin.password.length < 12) problems.push("ADMIN_PASSWORD must be at least 12 characters.");
  const accounts = getMailAccounts();
  if (accounts.length === 0) problems.push("No mailbox configured. Set MAIL_1 and MAIL_1_PASSWORD.");
  for (const a of accounts) if (!a.password) problems.push(`MAIL_${a.slot}_PASSWORD is not set.`);
  return problems;
}
