"""RAG chat assistant with a hand-rolled tool loop (no AgentExecutor)."""
import json
from collections import defaultdict

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from app.llm import chat_model
from app.agents.assistant.retrieval import retrieve
from app.agents.assistant.tools import TOOLS, TOOLS_BY_NAME, set_context

SYSTEM = (
    "You are a helpful support assistant. Answer using the provided context. "
    "Use get_account to look up balances and open_ticket for complaints."
)

MAX_ITERATIONS = 3

# in-memory history keyed by thread_id
_history = defaultdict(list)


def run_assistant(thread_id: str, user_id: str, message: str) -> str:
    set_context(thread_id, user_id)

    # retrieval step
    docs = retrieve(message)
    context = "\n\n".join(f"[{d['title']}] {d['text']}" for d in docs)

    messages = [
        SystemMessage(content=SYSTEM),
        SystemMessage(content=f"Context:\n{context}"),
        *_history[thread_id],
        HumanMessage(content=message),
    ]

    model = chat_model().bind_tools(TOOLS)

    final_text = ""
    for _ in range(MAX_ITERATIONS):
        response: AIMessage = model.invoke(messages)
        messages.append(response)
        if not response.tool_calls:
            final_text = response.content if isinstance(response.content, str) else json.dumps(response.content)
            break
        for call in response.tool_calls:
            tool = TOOLS_BY_NAME[call["name"]]
            result = tool.invoke(call["args"])
            messages.append(ToolMessage(content=json.dumps(result), tool_call_id=call["id"]))
    else:
        final_text = "I could not complete that within the allowed steps."

    _history[thread_id].append(HumanMessage(content=message))
    _history[thread_id].append(AIMessage(content=final_text))
    return final_text
