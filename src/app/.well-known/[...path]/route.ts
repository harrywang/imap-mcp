import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { auth } from "@/lib/auth";
import { setupFailure } from "@/lib/setup";

// MCP clients look for OAuth discovery documents at the site root, while Better Auth
// lives under /api/auth. These routes bridge the two:
//   /.well-known/oauth-protected-resource[/api/mcp]       (RFC 9728, from the mcp plugin)
//   /.well-known/oauth-authorization-server[/api/auth]    (RFC 8414)
//   /.well-known/openid-configuration[/api/auth]          (OIDC discovery)
const authServerMetadata = oauthProviderAuthServerMetadata(auth);
const openIdMetadata = oauthProviderOpenIdConfigMetadata(auth);

export async function GET(request: Request, ctx: RouteContext<"/.well-known/[...path]">) {
  const [kind] = (await ctx.params).path;
  const failure = await setupFailure("json");
  if (failure) return failure;
  switch (kind) {
    case "oauth-protected-resource":
      return auth.handler(request);
    case "oauth-authorization-server":
      return authServerMetadata(request);
    case "openid-configuration":
      return openIdMetadata(request);
    default:
      return new Response("Not found", { status: 404 });
  }
}
