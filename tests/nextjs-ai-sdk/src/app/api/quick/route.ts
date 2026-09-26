import { generateText } from "ai";
import { MODEL, openai } from "@/lib/llm";

export const runtime = "edge";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "ping";
  const { text, usage } = await generateText({
    model: openai.chat(MODEL),
    prompt: q,
  });
  return Response.json({ text, usage });
}
