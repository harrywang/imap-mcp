import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function SetupProblems({ problems }: { problems: string[] }) {
  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Finish setup</CardTitle>
          <CardDescription>
            Fix these in Vercel → Settings → Environment Variables and redeploy (or in .env.local when running locally).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
