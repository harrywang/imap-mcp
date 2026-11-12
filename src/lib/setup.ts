import "server-only";
import { getMigrations } from "better-auth/db/migration";
import { symmetricDecrypt } from "better-auth/crypto";
import { auth } from "./auth";
import { APP_URL, getAdminCredentials, getConfigProblems } from "./config";

let ready: Promise<void> | null = null;

/**
 * Runs once per server instance: creates/updates the database tables and makes
 * sure the single admin account exists with the password from ADMIN_PASSWORD.
 * This is what makes a fresh one-click deploy work without any manual steps.
 */
export function ensureSetup(): Promise<void> {
  if (!ready) {
    ready = doSetup().catch((err) => {
      ready = null; // retry on next request
      throw err;
    });
  }
  return ready;
}

/** A configuration mistake the owner can fix; its message is safe to show publicly. */
class SetupError extends Error {}

/**
 * Runs setup and, if it fails, returns a readable error response instead of a
 * bare 500, so Claude and the browser show what to fix.
 */
export async function setupFailure(format: "json" | "jsonrpc"): Promise<Response | null> {
  try {
    await ensureSetup();
    return null;
  } catch (err) {
    console.error(err);
    const message =
      err instanceof SetupError
        ? err.message
        : `imap-mcp setup failed (${(err as Error).name}). Check the server logs.`;
    const body =
      format === "jsonrpc"
        ? { jsonrpc: "2.0", id: null, error: { code: -32000, message } }
        : { error: "setup_incomplete", error_description: message };
    return Response.json(body, { status: 503 });
  }
}

async function doSetup() {
  const problems = getConfigProblems();
  if (problems.length) {
    throw new SetupError(
      `imap-mcp isn't set up yet: ${problems.join(" ")} Fix it in your environment variables, then open ${APP_URL} to check.`,
    );
  }

  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();

  const ctx = await auth.$context;
  await dropKeysFromOldSecret(ctx);

  const { email, password } = getAdminCredentials();

  // Single-user app: delete any other account (e.g. after ADMIN_EMAIL changes),
  // which also removes its sessions and OAuth grants.
  for (const user of await ctx.internalAdapter.listUsers()) {
    if (user.email.toLowerCase() !== email) await ctx.internalAdapter.deleteUser(user.id);
  }

  const existing = await ctx.internalAdapter.findUserByEmail(email, { includeAccounts: true });

  if (!existing) {
    const user = await ctx.internalAdapter.createUser(
      { email, name: "Admin", emailVerified: true },
      { method: "admin" },
    );
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: await ctx.password.hash(password),
    });
    return;
  }

  // Keep the stored password in sync with ADMIN_PASSWORD so changing the env var works.
  const credential = existing.accounts.find((a) => a.providerId === "credential");
  if (!credential?.password) {
    await ctx.internalAdapter.linkAccount({
      userId: existing.user.id,
      providerId: "credential",
      accountId: existing.user.id,
      password: await ctx.password.hash(password),
    });
  } else if (!(await ctx.password.verify({ password, hash: credential.password }))) {
    await ctx.internalAdapter.updatePassword(existing.user.id, await ctx.password.hash(password));
    // A changed password signs out every browser session.
    await ctx.internalAdapter.deleteUserSessions(existing.user.id);
  }
}

/**
 * Token signing keys are encrypted with BETTER_AUTH_SECRET. After the secret is
 * rotated they can't be decrypted, so delete them: a fresh key is created on
 * the next login and every token signed with the old key stops working.
 */
async function dropKeysFromOldSecret(ctx: Awaited<typeof auth.$context>) {
  const keys = await ctx.adapter.findMany<{ id: string; privateKey: string }>({ model: "jwks" });
  for (const key of keys) {
    const ok = await symmetricDecrypt({ key: ctx.secretConfig, data: JSON.parse(key.privateKey) })
      .then(() => true)
      .catch(() => false);
    if (!ok) await ctx.adapter.delete({ model: "jwks", where: [{ field: "id", value: key.id }] });
  }
}
