import "server-only";
import { db } from "../auth";

/** Max emails sent per mailbox per rolling hour. Override with SEND_LIMIT_PER_HOUR. */
export const SEND_LIMIT_PER_HOUR = Math.max(1, Number(process.env.SEND_LIMIT_PER_HOUR) || 10);

let ready: Promise<unknown> | null = null;
const ensureTable = () =>
  (ready ??= db.query(
    `CREATE TABLE IF NOT EXISTS imap_mcp_send_log (
       id bigserial PRIMARY KEY,
       account text NOT NULL,
       sent_at timestamptz NOT NULL DEFAULT now()
     );
     CREATE INDEX IF NOT EXISTS imap_mcp_send_log_account_time ON imap_mcp_send_log (account, sent_at);`,
  ).catch((e) => {
    ready = null;
    throw e;
  }));

/** Throws if this mailbox already sent its hourly quota. Stores only the mailbox and a timestamp. */
export async function checkSendLimit(account: string) {
  await ensureTable();
  const { rows } = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM imap_mcp_send_log WHERE account = $1 AND sent_at > now() - interval '1 hour'",
    [account.toLowerCase()],
  );
  if (Number(rows[0].n) >= SEND_LIMIT_PER_HOUR) {
    throw new Error(
      `Send limit reached: ${account} already sent ${SEND_LIMIT_PER_HOUR} emails in the last hour. ` +
        "Nothing was sent. Tell the user; they can try later or raise SEND_LIMIT_PER_HOUR.",
    );
  }
}

export async function recordSend(account: string) {
  await ensureTable();
  await db.query("INSERT INTO imap_mcp_send_log (account) VALUES ($1)", [account.toLowerCase()]);
  // Keep the table tiny: nothing older than a day is needed.
  await db.query("DELETE FROM imap_mcp_send_log WHERE sent_at < now() - interval '1 day'");
}
