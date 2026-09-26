import os

import uvicorn
from fastapi import FastAPI

from app.agents.assistant.router import router as chat_router
from app.routes.generate import router as generate_router

app = FastAPI(title="python-multiagent sandbox")
app.include_router(chat_router)
app.include_router(generate_router)


@app.get("/health")
def health():
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run("app.main:app", host="127.0.0.1", port=int(os.environ.get("PORT", "4410")), log_level="info")
