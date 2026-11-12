// End-to-end check of the OAuth + MCP flow, the same path claude.ai takes:
// discovery -> client registration -> authorize -> sign in -> consent -> token -> MCP calls.
// Usage: BASE=http://localhost:3100 EMAIL=you@x.com PASSWORD=... node scripts/smoke-test.mjs [tool] [jsonArgs]
import crypto from "node:crypto";

const BASE = process.env.BASE ?? "http://localhost:3000";
// Defaults to the app login from .env.local when run with `node --env-file=.env.local`.
const EMAIL = process.env.EMAIL ?? process.env.ADMIN_EMAIL ?? "admin@imap-mcp.local";
const PASSWORD = process.env.PASSWORD ?? process.env.ADMIN_PASSWORD;
// CIMD_CLIENT=<metadata URL> tests Client ID Metadata Documents instead of registration.
const CIMD = process.env.CIMD_CLIENT;
const REDIRECT = process.env.REDIRECT ?? "http://127.0.0.1:53682/callback";
const b64url = (b) => Buffer.from(b).toString("base64url");
const step = (m) => console.log(`\n== ${m}`);
const must = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } };

step("1. unauthenticated MCP call -> 401 + resource_metadata");
let r = await fetch(`${BASE}/api/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const challenge = r.headers.get("www-authenticate") ?? "";
console.log(r.status, challenge);
must(r.status === 401, "expected 401");
const prmUrl = challenge.match(/resource_metadata="([^"]+)"/)?.[1];

step("2. protected resource + auth server metadata");
const prm = await (await fetch(prmUrl)).json();
const issuer = new URL(prm.authorization_servers[0]);
const asm = await (await fetch(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`)).json();
console.log({ resource: prm.resource, registration: asm.registration_endpoint, cimd: asm.client_id_metadata_document_supported });

step(CIMD ? "3. CIMD client (no registration)" : "3. dynamic client registration");
const client = CIMD ? { client_id: CIMD } : await (await fetch(asm.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Smoke Test", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
})).json();
console.log(client.client_id);
must(client.client_id, JSON.stringify(client));

step("4. authorize (PKCE)");
const verifier = b64url(crypto.randomBytes(32));
const authUrl = new URL(asm.authorization_endpoint);
// OMIT_SCOPE / OMIT_RESOURCE mimic clients that leave those parameters out.
const authParams = {
  response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, scope: "openid offline_access",
  state: "xyz", code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", resource: prm.resource,
};
if (process.env.OMIT_SCOPE) delete authParams.scope;
if (process.env.OMIT_RESOURCE) delete authParams.resource;
Object.entries(authParams).forEach(([k, v]) => authUrl.searchParams.set(k, v));
const withResource = (o) => (process.env.OMIT_RESOURCE ? o : { ...o, resource: prm.resource });
r = await fetch(authUrl, { redirect: "manual" });
const authBody = r.headers.get("location") ? null : await r.text();
let loc = new URL(r.headers.get("location") ?? JSON.parse(authBody || "{}").url ?? "/null", BASE);
console.log(r.status, loc.pathname, authBody ? authBody.slice(0, 300) : "");
must(loc.pathname === "/sign-in", "expected redirect to /sign-in");

step("5. sign in with the signed oauth_query");
r = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD, oauth_query: loc.search.slice(1) }),
});
const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const signIn = await r.json();
console.log(r.status, signIn.url ?? signIn);
must(r.ok && signIn.url, "sign in failed");
loc = new URL(signIn.url, BASE);

if (loc.pathname === "/consent") {
  step("6. consent");
  r = await fetch(`${BASE}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie: cookies },
    body: JSON.stringify({ accept: true, oauth_query: loc.search.slice(1) }),
  });
  const consent = await r.json();
  console.log(r.status, consent.url ?? consent);
  must(consent.url, "consent failed");
  loc = new URL(consent.url);
}
const code = loc.searchParams.get("code");
must(code && loc.searchParams.get("state") === "xyz", `no code in ${loc}`);

step("7. token exchange");
r = await fetch(asm.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(withResource({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier })),
});
const tokens = await r.json();
console.log(r.status, { token_type: tokens.token_type, expires_in: tokens.expires_in, refresh: Boolean(tokens.refresh_token) });
must(tokens.access_token, JSON.stringify(tokens));
if (process.env.PRINT_TOKEN) console.log("TOKEN", tokens.access_token, tokens.refresh_token, client.client_id);

const rpc = async (method, params, id = 1) => {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokens.access_token}`, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))?.slice(5);
  return { status: res.status, body: json ? JSON.parse(json) : text };
};

step("8. MCP initialize + tools/list");
let out = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
console.log(out.status, out.body.result?.serverInfo);
must(out.status === 200, JSON.stringify(out.body));
out = await rpc("tools/list", {}, 2);
console.log(out.body.result?.tools?.map((t) => t.name));

// Pass "tool" '{"args":1}' pairs to call several tools with one login.
const argv = process.argv.slice(2);
if (argv.length === 0) argv.push("list_accounts", "{}");
for (let i = 0; i < argv.length; i += 2) {
  const tool = argv[i];
  step(`9. tools/call ${tool} ${argv[i + 1] ?? ""}`);
  out = await rpc("tools/call", { name: tool, arguments: JSON.parse(argv[i + 1] ?? "{}") }, 3 + i);
  console.log(out.body.result?.content?.[0]?.text ?? JSON.stringify(out.body));
}

step("10. refresh token");
r = await fetch(asm.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(withResource({ grant_type: "refresh_token", refresh_token: tokens.refresh_token ?? "", client_id: client.client_id })),
});
console.log(r.status, r.ok ? "refreshed" : await r.text());
console.log("\nOK");
