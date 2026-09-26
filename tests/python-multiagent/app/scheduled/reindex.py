"""Pretend cron: tag each doc with 3 keywords via raw openai calls, rewrite the index, exit.

Run with `python -m app.scheduled.reindex`.
"""
from app.llm import MODEL, client
from data.seed import INDEX_PATH, ensure_index, write_index


def keywords_for(doc: dict) -> list:
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "Return exactly 3 comma-separated keywords for the document."},
            {"role": "user", "content": f"{doc['title']}\n\n{doc['text']}"},
        ],
    )
    text = resp.choices[0].message.content or ""
    return [k.strip() for k in text.split(",") if k.strip()][:3]


def main():
    docs = ensure_index()
    for doc in docs:
        doc["keywords"] = keywords_for(doc)
        print(f"[reindex] {doc['id']}: {doc['keywords']}", flush=True)
    write_index(docs)
    print(f"[reindex] wrote {len(docs)} docs to {INDEX_PATH}", flush=True)


if __name__ == "__main__":
    main()
