import { Suspense } from "react";
import { connection } from "next/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { CheckCircle2, CircleAlert, Send, FileText } from "lucide-react";
import { Logo } from "@/components/logo";
import { SiteFooter } from "@/components/site-footer";
import { auth } from "@/lib/auth";
import { ALLOW_SEND, APP_URL, MCP_URL, getConfigProblems, getMailAccounts } from "@/lib/config";
import { ensureSetup } from "@/lib/setup";
import { resolveAccount, testImap } from "@/lib/mail/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyField } from "@/components/copy-field";
import { SignOutButton } from "@/components/sign-out-button";
import { SetupProblems } from "@/components/setup-problems";

export default function Home() {
  return (
    <Suspense fallback={<main className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">Loading…</main>}>
      <Dashboard />
    </Suspense>
  );
}

async function Dashboard() {
  // Read env vars and the session per request, never at build time.
  await connection();
  const problems = getConfigProblems();
  if (problems.length) return <SetupProblems problems={problems} />;

  await ensureSetup();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  return (
    <main className="mx-auto grid w-full max-w-2xl gap-6 px-4 py-10">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Logo className="size-10" />
          <div>
            <h1 className="text-lg font-semibold">IMAP MCP</h1>
            <p className="text-sm text-muted-foreground">{session.user.email}</p>
          </div>
        </div>
        <SignOutButton />
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Connect an agent</CardTitle>
          <CardDescription>
            Add the URL to any MCP client that supports remote servers with OAuth (claude.ai: Settings → Connectors → Add custom connector), then sign in here when asked.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <CopyField label="Connector URL" value={MCP_URL} />
          <CopyField label="Claude Code" value={`claude mcp add --transport http mail ${MCP_URL}`} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mailboxes</CardTitle>
          <CardDescription>
            Add more with MAIL_2 and MAIL_2_PASSWORD in Vercel → Settings → Environment Variables, then redeploy.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Suspense fallback={<p className="text-sm text-muted-foreground">Testing connections…</p>}>
            <MailboxStatus />
          </Suspense>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {ALLOW_SEND ? <Send className="size-4" /> : <FileText className="size-4" />}
            {ALLOW_SEND ? "Sending is on" : "Drafts only"}
          </CardTitle>
          <CardDescription>
            {ALLOW_SEND
              ? "Agents can send email directly. Remove ALLOW_SEND to go back to drafts only."
              : "Agents save replies to your Drafts folder and you send them yourself. Set ALLOW_SEND=true to let it send."}
          </CardDescription>
        </CardHeader>
      </Card>

      <p className="text-center text-xs text-muted-foreground">{APP_URL}</p>
      <SiteFooter />
    </main>
  );
}

async function MailboxStatus() {
  const accounts = await Promise.all(getMailAccounts().map(resolveAccount));
  const results = await Promise.all(accounts.map(testImap));
  return accounts.map((a, i) => (
    <div key={a.slot} className="flex items-start justify-between gap-4 rounded-lg border p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {results[i].ok ? (
            <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
          ) : (
            <CircleAlert className="size-4 shrink-0 text-destructive" />
          )}
          <span className="truncate font-medium">{a.email}</span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{results[i].detail}</p>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          IMAP {a.servers.imapHost}:{a.servers.imapPort} · SMTP {a.servers.smtpHost}:{a.servers.smtpPort} · {a.servers.source}
        </p>
      </div>
      <Badge variant="secondary">#{a.slot}</Badge>
    </div>
  ));
}
