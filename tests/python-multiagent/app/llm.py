"""Shared LLM clients.

Deliberate pitfall: the raw `openai.OpenAI` client is constructed at import
time, before any tracing library could have patched the module.  The worker
and the reindex script both import this and share the same client object.
"""
import os

from openai import OpenAI

OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "http://127.0.0.1:4420/v1")
LLM_TIMEOUT_S = float(os.environ.get("LLM_TIMEOUT_S", "1.0"))
MODEL = os.environ.get("LLM_MODEL", "gpt-4o-mini")

client = OpenAI(base_url=OPENAI_BASE_URL, api_key="test", timeout=LLM_TIMEOUT_S, max_retries=0)


def chat_model(**kwargs):
    """A fresh LangChain ChatOpenAI bound to the same mock endpoint."""
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        model=MODEL,
        base_url=OPENAI_BASE_URL,
        api_key="test",
        timeout=LLM_TIMEOUT_S,
        max_retries=0,
        **kwargs,
    )
