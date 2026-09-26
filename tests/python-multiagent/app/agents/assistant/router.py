from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.agents.assistant.agent import run_assistant

router = APIRouter()


class ChatBody(BaseModel):
    thread_id: str
    user_id: str
    message: str


@router.post("/chat")
def chat(body: ChatBody):
    try:
        reply = run_assistant(body.thread_id, body.user_id, body.message)
    except Exception as exc:  # LLM failures surface as 502
        raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}")
    return {"reply": reply}
