import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { setupFailure } from "@/lib/setup";

const handlers = toNextJsHandler(auth);

export async function GET(request: Request) {
  return (await setupFailure("json")) ?? handlers.GET(request);
}

export async function POST(request: Request) {
  return (await setupFailure("json")) ?? handlers.POST(request);
}
