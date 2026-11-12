import { SiteFooter } from "@/components/site-footer";
import { Suspense } from "react";
import { connection } from "next/server";
import { getAdminCredentials, getConfigProblems } from "@/lib/config";
import { SetupProblems } from "@/components/setup-problems";
import { SignInForm } from "./sign-in-form";

export default function SignInPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-4">
      <div className="flex w-full flex-col items-center">
        <Suspense>
          <SignIn />
          <SiteFooter />
        </Suspense>
      </div>
    </main>
  );
}

async function SignIn() {
  await connection(); // read env vars per request, not at build time
  const problems = getConfigProblems();
  if (problems.length) return <SetupProblems problems={problems} />;
  return <SignInForm email={getAdminCredentials().email} />;
}
