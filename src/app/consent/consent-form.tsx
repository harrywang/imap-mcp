"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

interface PublicClient {
  client_name?: string;
}

export function ConsentForm() {
  const params = useSearchParams();
  const clientId = params.get("client_id") ?? "";
  const [client, setClient] = useState<PublicClient | null>(null);
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId) return;
    authClient
      .$fetch<PublicClient>("/oauth2/public-client", { method: "GET", query: { client_id: clientId } })
      .then(({ data }) => setClient(data ?? {}));
  }, [clientId]);

  async function decide(accept: boolean) {
    setPending(accept ? "allow" : "deny");
    setError(null);
    const { data, error } = await authClient.$fetch<{ url: string }>("/oauth2/consent", {
      method: "POST",
      body: { accept },
    });
    if (error || !data?.url) {
      setError(error?.message || "Something went wrong. Start the connection again from your app.");
      setPending(null);
      return;
    }
    window.location.href = data.url;
  }

  const name = client?.client_name || "this app";
  // The app name is self-reported; the redirect host is where access is actually sent.
  let host: string | undefined;
  try {
    host = new URL(params.get("redirect_uri") ?? "").host;
  } catch {
    host = undefined;
  }

  return (
    <Card className="w-full max-w-sm pt-6 shadow-lg [--card-spacing:--spacing(6)]">
      <CardHeader className="justify-items-center gap-2 text-center">
        <div className="mb-1 flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <ShieldCheck className="size-6" />
        </div>
        <CardTitle className="text-2xl font-semibold tracking-tight">Allow {name}?</CardTitle>
        <CardDescription className="text-balance">
          {host ? <>Access will be sent to <span className="font-medium text-foreground">{host}</span>. </> : null}
          Only allow apps you just tried to connect yourself.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        <p className="mb-2">It will be able to use your MCP mail tools:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Search and read email in every configured mailbox</li>
          <li>Create drafts, move messages, mark read or unread</li>
          <li>Send a draft, only after you approve it in the chat</li>
        </ul>
        {error && <p className="mt-3 text-destructive">{error}</p>}
      </CardContent>
      <CardFooter className="gap-2 p-4">
        <Button variant="outline" className="flex-1" disabled={pending !== null} onClick={() => decide(false)}>
          {pending === "deny" ? "Denying…" : "Deny"}
        </Button>
        <Button className="flex-1" disabled={pending !== null} onClick={() => decide(true)}>
          {pending === "allow" ? "Allowing…" : "Allow"}
        </Button>
      </CardFooter>
    </Card>
  );
}
