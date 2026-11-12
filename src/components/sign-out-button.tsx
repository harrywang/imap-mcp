"use client";

import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        await authClient.signOut();
        window.location.href = "/sign-in";
      }}
    >
      Sign out
    </Button>
  );
}
