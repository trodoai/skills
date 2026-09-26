import { after } from "next/server";
import { generateText } from "ai";
import { MODEL, openai } from "@/lib/llm";

export const runtime = "nodejs";

type Ticket = { id: string; subject: string; body: string };

// In-memory store; survives across requests within one dev-server process.
const g = globalThis as unknown as { __summaries?: Map<string, string> };
const summaries = (g.__summaries ??= new Map<string, string>());

function isTicket(x: unknown): x is Ticket {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.subject === "string" &&
    typeof t.body === "string"
  );
}

export async function POST(req: Request) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!isTicket(payload)) {
    return Response.json({ error: "expected {id, subject, body}" }, { status: 400 });
  }
  const ticket = payload;

  // Respond 202 first; the summarisation runs after the response is sent.
  after(async () => {
    const { text } = await generateText({
      model: openai.chat(MODEL),
      system: "You summarise support tickets in one sentence.",
      prompt: `Summarise this support ticket.\nSubject: ${ticket.subject}\n\n${ticket.body}`,
    });
    summaries.set(ticket.id, text.trim());
  });

  return Response.json({ accepted: true, id: ticket.id }, { status: 202 });
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "missing id" }, { status: 400 });
  const summary = summaries.get(id);
  if (summary === undefined) {
    return Response.json({ id, ready: false }, { status: 404 });
  }
  return Response.json({ id, ready: true, summary });
}
