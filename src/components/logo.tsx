import Image from "next/image";
import { cn } from "@/lib/utils";

/** IMAP MCP mark: an envelope with a gear. Source file: public/logo.svg (also src/app/icon.svg for the favicon). */
export function Logo({ className }: { className?: string }) {
  return <Image src="/logo.svg" alt="" width={48} height={48} preload className={cn("size-12", className)} />;
}
