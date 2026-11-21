import { createMcpHandler } from "@modelcontextprotocol/server";
import { requireMcpAuth } from "@better-auth/mcp";
import { auth } from "@/lib/auth";
import { INTERNAL_URL, MCP_URL } from "@/lib/config";
import { setupFailure } from "@/lib/setup";
import { createMailServer } from "@/lib/mail/tools";

export const maxDuration = 60;

// Stateless: every request gets a fresh server. Accepts both current and 2025-era MCP clients.
const mcpHandler = createMcpHandler(() => createMailServer());

/**
 * MCP 2026-07-28 clients may open `subscriptions/listen` and keep it open to receive change notifications.
 * This server never sends any (its tool list is fixed), and on serverless the open request would just run
 * until the platform kills it (60s on Vercel), over and over. Answer it immediately instead.
 */
async function rejectListen(request: Request): Promise<Response | null> {
  if (request.method !== "POST") return null;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null;
  }
  const msg = body as { jsonrpc?: string; id?: string | number; method?: string };
  if (msg?.method !== "subscriptions/listen") return null;
  return Response.json({
    jsonrpc: "2.0",
    id: msg.id ?? null,
    error: { code: -32601, message: "subscriptions/listen is not supported: this server never sends notifications." },
  });
}

const protectedHandler = requireMcpAuth(auth, async (request) => (await rejectListen(request)) ?? mcpHandler.fetch(request), {
  resource: MCP_URL,
  jwksUrl: `${INTERNAL_URL}/api/auth/jwks`,
});

async function handler(request: Request) {
  return (await setupFailure("jsonrpc")) ?? protectedHandler(request);
}

export { handler as GET, handler as POST, handler as DELETE };
