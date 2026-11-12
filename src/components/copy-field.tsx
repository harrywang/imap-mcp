"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs leading-5 whitespace-nowrap">
          {value}
        </code>
        <Button
          variant="outline"
          size="icon"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}
