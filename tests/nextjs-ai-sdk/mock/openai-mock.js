// Offline OpenAI-shaped mock. Implements POST /v1/chat/completions (stream + non-stream).
// Behaviour is keyed off the last user message:
//   tools declared AND last user message contains "order" AND no tool result yet -> tool_calls(lookupOrder)
//   contains "title"  -> fixed title
//   contains "summar" -> fixed summary
//   otherwise         -> echo
const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.env.OPENAI_MOCK_PORT || 4520);

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((p) => (typeof p === "string" ? p : p.text || "")).join(" ");
  return "";
}

function decide(body) {
  const msgs = body.messages || [];
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const userText = textOf(lastUser && lastUser.content).toLowerCase();
  const systemText = msgs.filter((m) => m.role === "system").map((m) => textOf(m.content)).join(" ").toLowerCase();
  const hasToolResult = msgs.some((m) => m.role === "tool");
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  if (hasTools && userText.includes("order") && !hasToolResult) {
    const m = userText.match(/order\s*#?\s*([a-z0-9-]+)/i);
    const orderId = (m && m[1]) || "unknown";
    return {
      kind: "tool_calls",
      tool_calls: [
        {
          id: "call_" + crypto.randomUUID().slice(0, 8),
          type: "function",
          function: { name: "lookupOrder", arguments: JSON.stringify({ orderId }) },
        },
      ],
    };
  }
  if (hasToolResult) {
    const toolMsg = [...msgs].reverse().find((m) => m.role === "tool");
    let status = "in transit";
    try {
      const o = JSON.parse(textOf(toolMsg.content));
      status = `${o.status} via ${o.carrier}, ETA ${o.eta}`;
    } catch {}
    return { kind: "text", text: `Your order is ${status}.` };
  }
  if (userText.includes("title") || systemText.includes("title")) {
    return { kind: "text", text: "Order Status Inquiry" };
  }
  if (userText.includes("summar") || systemText.includes("summar")) {
    return { kind: "text", text: "Customer reports a delayed order and asks for an update." };
  }
  return { kind: "text", text: `Echo: ${textOf(lastUser && lastUser.content)}` };
}

function usageFor(body, outText) {
  const prompt_tokens = Math.max(1, Math.round(JSON.stringify(body.messages || []).length / 4));
  const completion_tokens = Math.max(1, Math.round((outText || "").length / 4) + 2);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"ok":true}');
  }
  if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: `mock: unsupported ${req.method} ${req.url} (only POST /v1/chat/completions)` } }));
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "invalid json" } }));
  }

  const id = "chatcmpl-" + crypto.randomUUID().slice(0, 12);
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || "mock-model";
  const d = decide(body);
  const outText = d.kind === "text" ? d.text : "";
  const usage = usageFor(body, outText || JSON.stringify(d.tool_calls));
  const finish_reason = d.kind === "tool_calls" ? "tool_calls" : "stop";
  console.log(`[openai-mock] ${d.kind} stream=${!!body.stream} tools=${(body.tools || []).length} model=${model}`);

  if (!body.stream) {
    const message =
      d.kind === "tool_calls"
        ? { role: "assistant", content: null, tool_calls: d.tool_calls }
        : { role: "assistant", content: d.text };
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        id, object: "chat.completion", created, model,
        choices: [{ index: 0, message, finish_reason, logprobs: null }],
        usage,
      })
    );
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const chunk = (delta, fr = null) => ({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: fr, logprobs: null }],
  });

  send(chunk({ role: "assistant", content: "" }));
  if (d.kind === "tool_calls") {
    d.tool_calls.forEach((tc, i) => {
      send(chunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }));
      send(chunk({ tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] }));
    });
  } else {
    const words = d.text.split(/(?<=\s)/);
    for (const w of words) {
      send(chunk({ content: w }));
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  send(chunk({}, finish_reason));
  // Final usage chunk (OpenAI shape when stream_options.include_usage is set; sent regardless).
  send({ id, object: "chat.completion.chunk", created, model, choices: [], usage });
  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[openai-mock] listening on http://127.0.0.1:${PORT}/v1`);
});
