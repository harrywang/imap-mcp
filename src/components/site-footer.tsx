import Image from "next/image";

const REPO_URL = "https://github.com/harrywang/imap-mcp";

export function SiteFooter() {
  return (
    <footer className="mt-5 flex items-center justify-center gap-1 text-sm text-muted-foreground">
      <a
        href={REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="View source on GitHub"
        title="View source on GitHub"
        className="inline-flex items-center justify-center rounded-full p-1 transition-colors hover:bg-muted"
      >
        <Image src="/github.svg" alt="GitHub" width={24} height={24} className="dark:invert" />
      </a>
      <span>
        Made by{" "}
        <a
          href="https://harrywang.me/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 transition-colors hover:text-foreground"
        >
          Harry Wang
        </a>
      </span>
    </footer>
  );
}
