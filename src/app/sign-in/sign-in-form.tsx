"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Lock, UserRound } from "lucide-react";
import { Logo } from "@/components/logo";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignInForm({ email }: { email: string }) {
  const params = useSearchParams();
  const fromOAuth = params.has("client_id");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    // When we arrived from /oauth2/authorize, the oauth-provider client plugin
    // attaches the signed request and the server continues the OAuth flow.
    const { data, error } = await authClient.signIn.email({
      email,
      password: String(form.get("password")),
    });
    if (error) {
      setError(
        error.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : error.status === 401
            ? "Wrong email or password."
            : error.message || "Sign-in failed.",
      );
      setPending(false);
      return;
    }
    const next = (data as { url?: string } | null)?.url;
    window.location.href = next || "/";
  }

  return (
    <Card className="w-full max-w-sm py-6 shadow-lg [--card-spacing:--spacing(6)]">
      <CardHeader className="justify-items-center gap-2 text-center">
        <Logo className="mb-1" />
        <CardTitle className="text-2xl font-semibold tracking-tight">IMAP MCP</CardTitle>
        <CardDescription className="text-balance">
          Connect agents to any IMAP mailbox.
        </CardDescription>
        {fromOAuth && (
          <p className="mt-1 rounded-md bg-muted px-3 py-1.5 text-xs text-muted-foreground">
            An app wants to connect to your mailboxes. Sign in to continue.
          </p>
        )}
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          {/* Hidden field so password managers pair the saved password with this account. */}
          <input type="email" name="email" autoComplete="username" value={email} readOnly hidden />
          <div className="flex items-center justify-center gap-2 rounded-full border bg-muted/60 px-3 py-1.5 text-sm text-muted-foreground">
            <UserRound className="size-4 shrink-0" />
            <span className="truncate">{email}</span>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              className="h-10"
              aria-invalid={error ? true : undefined}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" size="lg" className="h-10 w-full" disabled={pending}>
            {pending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Signing in…
              </>
            ) : (
              "Sign in"
            )}
          </Button>
          <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3" />
            Your mail credentials never leave this server.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
