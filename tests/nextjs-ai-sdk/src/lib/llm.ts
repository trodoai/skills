import { createOpenAI } from "@ai-sdk/openai";

// Module-level provider. The mock only implements /v1/chat/completions, so every
// call site must use `openai.chat(MODEL)` — the bare `openai(MODEL)` form targets
// the Responses API (/v1/responses), which the mock does not implement.
export const openai = createOpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: "test",
});

export const MODEL = "gpt-4o-mini";
