"""Multiplexed /generate: one handler, three distinct one-shot LLM calls."""
from typing import Literal

from fastapi import APIRouter, HTTPException
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel

from app.llm import chat_model

router = APIRouter()

PROMPTS = {
    "email": "You write short, polite customer emails. Return only the email body.",
    "sql": "You are a SQL expert. Return a single valid PostgreSQL query and nothing else.",
    "summary": "You summarise text in two sentences. Return only the summary.",
}


class GenerateBody(BaseModel):
    kind: Literal["email", "sql", "summary"]
    input: str


@router.post("/generate")
def generate(body: GenerateBody):
    system = PROMPTS[body.kind]
    model = chat_model(temperature=0)
    try:
        result = model.invoke([SystemMessage(content=system), HumanMessage(content=body.input)])
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}")
    return {"kind": body.kind, "output": result.content}
