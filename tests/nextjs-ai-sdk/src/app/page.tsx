"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useRef, useState } from "react";
import { generateTitle } from "./actions/title";

const USER_ID = "web-user";
const CHAT_ID = "web-chat";

export default function Page() {
  const [input, setInput] = useState("");
  const [title, setTitle] = useState<string | null>(null);
  const titled = useRef(false);

  const { messages, sendMessage, status } = useChat({
    id: CHAT_ID,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      headers: { "x-user-id": USER_ID },
    }),
  });

  // After the first assistant reply completes, ask the title agent once.
  useEffect(() => {
    if (titled.current || status !== "ready") return;
    if (!messages.some((m) => m.role === "assistant")) return;
    titled.current = true;
    generateTitle(messages).then(setTitle).catch(() => setTitle("(title failed)"));
  }, [messages, status]);

  return (
    <main style={{ maxWidth: 640 }}>
      <h1>{title ?? "AI SDK sandbox"}</h1>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {messages.map((m) => (
          <li key={m.id} style={{ margin: "8px 0" }}>
            <strong>{m.role}:</strong>{" "}
            {m.parts.map((p, i) => {
              if (p.type === "text") return <span key={i}>{p.text}</span>;
              if (p.type.startsWith("tool-"))
                return (
                  <code key={i} style={{ display: "block", opacity: 0.7 }}>
                    {p.type} {JSON.stringify("output" in p ? p.output : null)}
                  </code>
                );
              return null;
            })}
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim()) return;
          sendMessage({ text: input });
          setInput("");
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Say something (try: where is my order 5551?)"
          style={{ width: "80%", padding: 8 }}
          disabled={status !== "ready"}
        />
        <button type="submit" disabled={status !== "ready"} style={{ padding: 8 }}>
          Send
        </button>
      </form>
    </main>
  );
}
