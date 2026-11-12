import { SiteFooter } from "@/components/site-footer";
import { Suspense } from "react";
import { ConsentForm } from "./consent-form";

export default function ConsentPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-4">
      <div className="flex w-full flex-col items-center">
        <Suspense>
          <ConsentForm />
          <SiteFooter />
        </Suspense>
      </div>
    </main>
  );
}
