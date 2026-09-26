"""Seed knowledge base.  data/doc_index.json is generated from this at runtime."""
import json
import os

DATA_DIR = os.path.dirname(os.path.abspath(__file__))
INDEX_PATH = os.path.join(DATA_DIR, "doc_index.json")

SEED_DOCS = [
    {
        "id": "refunds",
        "title": "Refund policy",
        "text": "Refunds take 5 to 7 business days to appear on your statement after approval. "
                "Refund requests are reviewed within 24 hours.",
        "keywords": [],
    },
    {
        "id": "accounts",
        "title": "Account balances",
        "text": "Your account balance is shown on the dashboard. Support agents can look up an "
                "account by its numeric account id.",
        "keywords": [],
    },
    {
        "id": "security",
        "title": "Security and two-factor authentication",
        "text": "We support two-factor authentication via authenticator apps and SMS. Enable it "
                "under Settings > Security.",
        "keywords": [],
    },
]


def ensure_index():
    """Write doc_index.json from the seed if it does not exist; return the docs."""
    if os.path.exists(INDEX_PATH):
        try:
            with open(INDEX_PATH) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    write_index(SEED_DOCS)
    return json.loads(json.dumps(SEED_DOCS))


def write_index(docs):
    with open(INDEX_PATH, "w") as f:
        json.dump(docs, f, indent=2)
