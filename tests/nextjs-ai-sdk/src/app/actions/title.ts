"use server";

import { generateText, type UIMessage } from "ai";
import { MODEL, openai } from "@/lib/llm";

function flatten(messages: UIMessage[]): string {
  return messages
    .map((m) => {
      const text = m.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join(" ");
      return `${m.role}: ${text}`;
    })
    .join("\n");
}

// The "title agent": one generateText call, invoked from the client as a Server
// Action after the first assistant reply (and from POST /api/title for scripting).
export async function generateTitle(messages: UIMessage[]): Promise<string> {
  const { text } = await generateText({
    model: openai.chat(MODEL),
    system: "You write short conversation titles.",
    prompt: `Write a 3-5 word title for this conversation:\n\n${flatten(messages)}`,
  });
  return text.trim();
}
