import { createMcpHandler } from "@modelcontextprotocol/server";
import { requireMcpAuth } from "@better-auth/mcp";
import { auth } from "@/lib/auth";
import { MCP_URL } from "@/lib/config";
import { setupFailure } from "@/lib/setup";
import { createMailServer } from "@/lib/mail/tools";

export const maxDuration = 60;

// Stateless: every request gets a fresh server. Accepts both current and 2025-era MCP clients.
const mcpHandler = createMcpHandler(() => createMailServer());

const protectedHandler = requireMcpAuth(auth, (request) => mcpHandler.fetch(request), {
  resource: MCP_URL,
});

async function handler(request: Request) {
  return (await setupFailure("jsonrpc")) ?? protectedHandler(request);
}

export { handler as GET, handler as POST, handler as DELETE };
