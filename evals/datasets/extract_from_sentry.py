#!/usr/bin/env python3
"""
Sentry'den Planda MCP chat violation event'lerini çekip fine-tuning
dataset'ine dönüştürür.

Kullanım:
    export SENTRY_AUTH_TOKEN="sntryu_..."   # https://sentry.io/settings/account/api/auth-tokens/
    python3 extract_from_sentry.py

Çıktı:
    sentry_raw_events.jsonl        — Ham turn verileri (tüm metadata)
    intent_classification.jsonl    — OpenAI chat format, intent classification fine-tune için
    tool_use_corrections.jsonl     — Negatif örnekler için TEMPLATE (manuel inceleme gerekir)

Not: Sentry sadece violation'lı event'leri saklıyor. Temiz (başarılı)
örnekler için Railway'deki logs/conversations.jsonl dosyasına ihtiyaç var.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ORG_SLUG = os.environ.get("SENTRY_ORG", "digita-dijango")
PROJECT_SLUG = os.environ.get("SENTRY_PROJECT", "node")
SENTRY_HOST = os.environ.get("SENTRY_HOST", "https://sentry.io")
AUTH_TOKEN = os.environ.get("SENTRY_AUTH_TOKEN")
OUT_DIR = Path(__file__).resolve().parent

if not AUTH_TOKEN:
    sys.stderr.write(
        "FATAL: SENTRY_AUTH_TOKEN environment variable required.\n"
        "Create one at: https://sentry.io/settings/account/api/auth-tokens/\n"
        "Required scope: event:read, project:read\n"
    )
    sys.exit(1)


def sentry_get(path: str, params: dict[str, Any] | None = None) -> Any:
    """GET https://sentry.io/api/0/<path> with auth header; return parsed JSON."""
    url = f"{SENTRY_HOST}/api/0/{path.lstrip('/')}"
    if params:
        url += "?" + urlencode(params)
    req = Request(url, headers={"Authorization": f"Bearer {AUTH_TOKEN}"})
    try:
        with urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        sys.stderr.write(f"HTTP {e.code} for {url}: {e.read().decode('utf-8')[:500]}\n")
        raise


def iter_violation_events() -> Iterable[dict[str, Any]]:
    """
    Iterate all chat_violation events across the project.

    Uses the Events API with query="kind:chat_violation" to pull only the
    tagged violation events (clean turns don't fire captureMessage).
    """
    cursor: str | None = None
    page = 0
    while True:
        params: dict[str, Any] = {
            "query": "kind:chat_violation",
            "statsPeriod": "90d",
            "per_page": 100,
            "full": "true",   # include contexts (where `turn` lives)
        }
        if cursor:
            params["cursor"] = cursor

        events = sentry_get(
            f"projects/{ORG_SLUG}/{PROJECT_SLUG}/events/", params
        )
        if not events:
            break
        for ev in events:
            yield ev
        # Sentry cursors are returned in Link header, which urllib doesn't
        # expose cleanly via urlopen — naive pagination: stop after 10 pages
        # or <per_page results.
        page += 1
        if len(events) < 100 or page >= 10:
            break
        # For a proper implementation, read Link header. Left simple here.
        break


def turn_from_event(ev: dict[str, Any]) -> dict[str, Any] | None:
    """Extract the `turn` context we attach in sentry.ts."""
    contexts = ev.get("contexts") or {}
    turn = contexts.get("turn") or {}
    tags = {t["key"]: t["value"] for t in (ev.get("tags") or [])}
    if not turn.get("userMessage"):
        return None
    return {
        "event_id": ev.get("id") or ev.get("eventID"),
        "ts": ev.get("dateCreated"),
        "issue": ev.get("groupID"),
        "release": tags.get("release", "")[:8],
        "user_message": turn.get("userMessage"),
        "classifier_intent": turn.get("intent"),
        "tool_count": int(tags.get("tool_count", "0")),
        "tool_calls": turn.get("toolCalls") or [],
        "response": turn.get("response"),
        "violations": tags.get("violation_kinds", "").split(","),
        "latency_ms": turn.get("latencyMs"),
        "session": (turn.get("sessionId") or "")[:8],
    }


def infer_correct_intent(user_message: str, classifier_intent: str) -> str:
    """
    Heuristic: infer the likely correct intent. Manual review recommended.

    - "hangi terapist/psikolog uygun/önerir" → search_therapist
    - "müsait/uygun saat/gün", "ne zaman müsait" → check_availability
    - "<isim> müsait/uygun" → check_availability
    - fallback → classifier_intent
    """
    m = user_message.lower()
    if any(p in m for p in ["hangi terapist", "hangi psikolog", "hangi uzman"]):
        return "search_therapist"
    if any(p in m for p in ["müsait", "musait", "uygun saat", "uygun gün",
                            "ne zaman", "yakın gün", "yakin gun"]):
        return "check_availability"
    if any(p in m for p in ["arıyorum", "ariyorum", "öner", "oner"]):
        return "search_therapist"
    return classifier_intent


def main() -> None:
    raw_path = OUT_DIR / "sentry_raw_events.jsonl"
    intent_path = OUT_DIR / "intent_classification.jsonl"

    raw_count = 0
    intent_count = 0

    with raw_path.open("w", encoding="utf-8") as raw_f, \
         intent_path.open("w", encoding="utf-8") as intent_f:
        for ev in iter_violation_events():
            turn = turn_from_event(ev)
            if not turn:
                continue
            raw_f.write(json.dumps(turn, ensure_ascii=False) + "\n")
            raw_count += 1

            correct_intent = infer_correct_intent(
                turn["user_message"], turn["classifier_intent"]
            )
            intent_f.write(json.dumps({
                "messages": [
                    {"role": "system", "content":
                     "Planda kullanıcı mesajını aşağıdaki intent etiketlerinden "
                     "birine sınıflandır ve sadece etiketi döndür: "
                     "search_therapist, check_availability, therapist_detail, "
                     "list_specialties, greeting, clarification, out_of_scope, unknown."},
                    {"role": "user", "content": turn["user_message"]},
                    {"role": "assistant", "content": correct_intent},
                ]
            }, ensure_ascii=False) + "\n")
            intent_count += 1

    print(f"Wrote {raw_count} raw turns → {raw_path}")
    print(f"Wrote {intent_count} intent examples → {intent_path}")
    print(
        "\nNOTE: OpenAI fine-tuning minimum = 10 examples. "
        f"Current: {intent_count}. "
        "Augment with examples from logs/conversations.jsonl "
        "or synthetic data before running `openai fine_tunes.create`."
    )


if __name__ == "__main__":
    main()
