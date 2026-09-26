"""Keyword-overlap retrieval over the doc index."""
import re

from data.seed import ensure_index

_WORD = re.compile(r"[a-z0-9]+")


def _tokens(text):
    return set(_WORD.findall(text.lower()))


def retrieve(query, k=2):
    docs = ensure_index()
    q = _tokens(query)
    scored = []
    for d in docs:
        words = _tokens(d["title"] + " " + d["text"] + " " + " ".join(d.get("keywords", [])))
        overlap = len(q & words)
        scored.append((overlap, d))
    scored.sort(key=lambda s: s[0], reverse=True)
    return [d for score, d in scored[:k] if score > 0] or [scored[0][1]]
