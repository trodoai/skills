import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import { MODEL, openai } from "@/lib/llm";
import { tools } from "@/lib/tools";

export const runtime = "nodejs";
export const maxDuration = 60;

type ChatBody = {
  id?: string;
  chatId?: string;
  messages: UIMessage[];
};

export async function POST(req: Request) {
  const body = (await req.json()) as ChatBody;
  const userId = req.headers.get("x-user-id") ?? "anonymous";
  const chatId = body.id ?? body.chatId ?? "no-chat-id";

  const result = streamText({
    model: openai.chat(MODEL),
    system: `You are a helpful support assistant. user=${userId} chat=${chatId}`,
    messages: await convertToModelMessages(body.messages),
    tools,
    stopWhen: stepCountIs(4),
  });

  return result.toUIMessageStreamResponse();
}
