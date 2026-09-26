import type { UIMessage } from "ai";
import { generateTitle } from "@/app/actions/title";

export const runtime = "nodejs";

// Server Actions cannot be curl'd directly; this route makes generateTitle drivable.
export async function POST(req: Request) {
  const body = (await req.json()) as { messages?: UIMessage[] };
  const title = await generateTitle(body.messages ?? []);
  return Response.json({ title });
}
