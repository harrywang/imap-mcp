import "server-only";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { Pool } from "pg";
import { APP_URL, DATABASE_URL, MCP_URL } from "./config";

export const auth = betterAuth({
  baseURL: APP_URL,
  basePath: "/api/auth",
  trustedOrigins: [APP_URL],
  database: new Pool({ connectionString: DATABASE_URL || undefined, max: 3 }),
  // Single-user app: the one account is created from env vars by ensureSetup().
  emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
  session: { expiresIn: 60 * 60 * 24 * 7 },
  // Brute-force protection that holds across serverless instances.
  rateLimit: {
    enabled: true,
    storage: "database",
    customRules: { "/sign-in/email": { window: 60, max: 5 } },
  },
  // Session JWTs must not share the access-token signing key.
  disabledPaths: ["/token"],
  plugins: [
    jwt({ disableSettingJwtHeader: true }),
    mcp({
      loginPage: "/sign-in",
      consentPage: "/consent",
      resource: MCP_URL,
      // Claude registers itself; it still needs your login + consent to get a token.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // Claude Code / Desktop use an http://localhost callback and may omit application_type.
      clientRegistrationDefaultApplicationType: "infer",
      accessTokenExpiresIn: 60 * 60,
      refreshTokenExpiresIn: 60 * 60 * 24 * 30,
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    nextCookies(),
  ],
});
