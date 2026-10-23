from datetime import datetime
from pathlib import Path
import json
import re

from ddgs import DDGS
from urllib.request import Request, urlopen


def search_web(
    query: str,
    max_results: int = 5,
):
    results = DDGS().text(
        query,
        region="it-it",
        safesearch="moderate",
        max_results=max_results,
    )

    clean = []

    for item in results:
        clean.append({
            "title": str(
                item.get("title", "")
            ).strip(),

            "url": str(
                item.get("href", "")
            ).strip(),

            "snippet": str(
                item.get("body", "")
            ).strip(),
        })

    return clean


def extract_page(url: str):
    try:
        result = DDGS().extract(
            url,
            fmt="text_markdown",
        )

        content = str(
            result.get(
                "content",
                "",
            )
        )

        return content[:7000]

    except Exception:
        return ""


def research_topic(
    query: str,
    ollama_url: str,
    ollama_model: str,
):
    results = search_web(
        query,
        max_results=5,
    )

    if not results:
        raise RuntimeError(
            "No search results found."
        )

    sources = []

    for item in results[:4]:
        content = extract_page(
            item["url"]
        )

        sources.append({
            "title":
                item["title"],

            "url":
                item["url"],

            "snippet":
                item["snippet"],

            "content":
                content,
        })

    source_text = []

    for index, item in enumerate(
        sources,
        start=1,
    ):
        source_text.append(
            f"""
SOURCE {index}
TITLE: {item["title"]}
URL: {item["url"]}
SNIPPET:
{item["snippet"]}

PAGE CONTENT:
{item["content"][:5000]}
"""
        )

    prompt = f"""
You are ULTRON's research engine.

Answer the user's research request in Italian.

Rules:
- Use ONLY information supported by the supplied sources.
- Do not invent facts.
- Clearly separate established information from uncertainty.
- Keep the answer useful and reasonably concise.
- At the end, provide a SOURCES section containing the source
  titles and URLs.

USER REQUEST:
{query}

SOURCES:
{"".join(source_text)}
"""

    payload = {
        "model": ollama_model,
        "messages": [
            {
                "role": "system",
                "content":
                    "You are a careful research assistant. "
                    "Answer in Italian.",
            },
            {
                "role": "user",
                "content": prompt,
            },
        ],
        "stream": False,
        "options": {
            "temperature": 0.15,
            "num_predict": 900,
        },
    }

    request = Request(
        ollama_url,
        data=json.dumps(
            payload,
            ensure_ascii=False,
        ).encode("utf-8"),
        headers={
            "Content-Type":
                "application/json",
        },
        method="POST",
    )

    with urlopen(
        request,
        timeout=120,
    ) as response:
        data = json.loads(
            response.read().decode(
                "utf-8"
            )
        )

    reply = str(
        data
        .get("message", {})
        .get("content", "")
    ).strip()

    if not reply:
        raise RuntimeError(
            "Research model returned empty output."
        )

    return {
        "reply": reply,
        "sources": [
            {
                "title":
                    item["title"],
                "url":
                    item["url"],
            }
            for item in sources
        ],
    }


def _safe_filename(name: str):
    name = re.sub(
        r"[^\w\s-]",
        "",
        name,
        flags=re.UNICODE,
    )

    name = re.sub(
        r"\s+",
        "-",
        name.strip(),
    )

    return (
        name[:90]
        or "ULTRON-Research"
    )


def write_research_note(
    vault_path: str,
    title: str,
    markdown: str,
):
    if not vault_path:
        raise RuntimeError(
            "Obsidian vault is not configured."
        )

    vault = Path(
        vault_path
    ).expanduser().resolve()

    if not vault.exists():
        raise RuntimeError(
            "Obsidian vault does not exist."
        )

    research_dir = vault / "Research"

    research_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    filename = (
        _safe_filename(title)
        + ".md"
    )

    target = research_dir / filename

    counter = 2

    while target.exists():
        target = research_dir / (
            f"{_safe_filename(title)}"
            f"-{counter}.md"
        )

        counter += 1

    timestamp = datetime.now().astimezone()

    document = f"""---
type: research
created: {timestamp.isoformat()}
source: ULTRON
---

# {title}

{markdown}
"""

    target.write_text(
        document,
        encoding="utf-8",
    )

    return str(target)
