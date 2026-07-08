#!/usr/bin/env python3
"""Rewrite record descriptions as modern Swedish text (not summaries).

Reads existing JSON records that already have metadata.original_spelling and replaces
description (and optionally label) with a faithful modern rendering via Gemini Flash.

Usage:
  python tools/rewrite_descriptions.py --local          # Newscript/output_json/*
  python tools/rewrite_descriptions.py --newspapers     # extracted_newspapers.json
  python tools/rewrite_descriptions.py --input path.json
  python tools/rewrite_descriptions.py --local --limit 5 --dry-run

Ctrl+C stops after the current record; each update is saved immediately.

Requires GEMINI_API_KEY in the environment or .env file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

try:
    import requests
except ModuleNotFoundError:
    print("Error: pip install requests")
    sys.exit(1)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOCAL_JSON_DIR = PROJECT_ROOT / "Newscript" / "output_json"
NEWSPAPERS_JSON = PROJECT_ROOT / "data_sources" / "extracted_newspapers.json"
CACHE_PATH = PROJECT_ROOT / "data_sources" / ".description_rewrite_cache.json"

DEFAULT_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
PROMPT_VERSION = 2
RETRYABLE_STATUS = {429, 500, 502, 503, 504}

GENERIC_SUMMARY_RE = re.compile(
    r"^(denna notis|notisen|notis om|i notisen|texten handlar|här listas|listan innehåller|"
    r"annonserar|meddelar att|upplyser om)",
    re.IGNORECASE,
)

MODERNIZE_PROMPT = """Du är redaktör för en historisk databas. Nedan står en svensk tidningsnotis
från 1700-talet (OCR-transkriberad, med gammal stavning). Skriv om den till klar MODERN svenska
som visas för läsaren — INTE en kort sammanfattning, utan en moderniserad version av hela notisen.

Regler:
- Modernisera stavning och grammatik (hwar -> var, af -> av, frän -> från, wid -> vid).
- Rätta uppenbara OCR-fel (t.ex. "bortkappad" -> "borttappad", "tiskanna" -> "tillkänna").
- Behåll ALL information från originaltexten: vem, vad, var, när, belopp, husnummer, kontakt,
  belöning, auktionsvillkor m.m. Utelämna inget väsentligt. Hitta inte på fakta.
- Person- och ortnamn behåller sin form men rättas vid uppenbara OCR-skador.
- Längd ska motsvara originaltexten. Om originaltexten är en lista, behåll listan.

FÖRBJUDET:
- Skriv ALDRIG meta-text som "Denna notis anger...", "Notisen handlar om...", "Här listas..."
- Skriv ALDRIG en kort sammanfattning i stället för att modernisera originaltexten.

För ankomst-/adresslistor (Ankomne Resande, "bor hos", "logerar"):
- Behåll alla personer, titlar, adresser och husnummer i samma ordning.

NUVARANDE RUBRIK: {label}

ORIGINALTEXT (1700-talssvenska):
{original}
"""

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "label": {"type": "string"},
        "description": {"type": "string"},
    },
    "required": ["label", "description"],
}

_STOP_REQUESTED = False


def install_stop_handler() -> None:
    def _handler(signum: int, _frame: Any) -> None:
        global _STOP_REQUESTED
        if _STOP_REQUESTED:
            print("\nForce quit.", flush=True)
            raise SystemExit(130)
        _STOP_REQUESTED = True
        print(
            "\nStop requested — finishing current record, saving checkpoints, then exiting.",
            flush=True,
        )

    signal.signal(signal.SIGINT, _handler)
    signal.signal(signal.SIGTERM, _handler)


def stop_requested() -> bool:
    return _STOP_REQUESTED


def rebuild_all_records(json_dir: Path) -> int:
    combined: List[Dict[str, Any]] = []
    for page_file in sorted(json_dir.glob("*.json")):
        if page_file.name == "all_records.json":
            continue
        try:
            page = json.loads(page_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if isinstance(page, list):
            combined.extend(page)
    if combined:
        write_json_atomic(json_dir / "all_records.json", combined)
    return len(combined)


def load_env_file() -> None:
    for path in [PROJECT_ROOT / ".env", Path(".env")]:
        if not path.exists():
            continue
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def cache_key(record_id: str, original: str) -> str:
    digest = hashlib.sha256(original.encode("utf-8")).hexdigest()[:16]
    return f"v{PROMPT_VERSION}:{record_id}:{digest}"


def load_cache() -> Dict[str, Any]:
    if not CACHE_PATH.exists():
        return {}
    try:
        with CACHE_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_cache(cache: Dict[str, Any]) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE_PATH.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)
    tmp.replace(CACHE_PATH)


def original_spelling(record: Dict[str, Any]) -> str:
    meta = record.get("metadata")
    if isinstance(meta, dict):
        text = meta.get("original_spelling") or meta.get("original_text")
        if text:
            return str(text).strip()
    return str(record.get("description") or "").strip()


def modernize_with_gemini(
    label: str, original: str, api_key: str, model: str, max_attempts: int = 4
) -> Optional[Dict[str, str]]:
    prompt = MODERNIZE_PROMPT.format(label=label or "Notis", original=original[:6000])
    urls = [
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}",
        f"https://generativelanguage.googleapis.com/v1/models/{model}:generateContent?key={api_key}",
    ]
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generation_config": {
            "response_mime_type": "application/json",
            "response_schema": RESPONSE_SCHEMA,
        },
    }

    response = None
    for attempt in range(1, max_attempts + 1):
        try:
            response = requests.post(
                urls[0], headers={"Content-Type": "application/json"}, json=payload, timeout=120
            )
            if response.status_code == 404 and len(urls) > 1:
                urls.pop(0)
                response = requests.post(
                    urls[0], headers={"Content-Type": "application/json"}, json=payload, timeout=120
                )
            if response.status_code in RETRYABLE_STATUS:
                wait = 2**attempt
                print(f"  API {response.status_code}; retry in {wait}s ({attempt}/{max_attempts})")
                time.sleep(wait)
                continue
            break
        except requests.RequestException as exc:
            wait = 2**attempt
            print(f"  Network error ({exc}); retry in {wait}s ({attempt}/{max_attempts})")
            time.sleep(wait)
            response = None

    if response is None or response.status_code != 200:
        status = response.status_code if response is not None else "no response"
        body = response.text[:300] if response is not None else ""
        print(f"  Gemini error ({status}): {body}")
        return None

    try:
        res_data = response.json()
        text_content = res_data["candidates"][0]["content"]["parts"][0]["text"].strip()
        if text_content.startswith("```"):
            text_content = re.sub(r"^```(?:json)?\s*", "", text_content)
            text_content = re.sub(r"\s*```$", "", text_content)
        parsed = json.loads(text_content)
        out_label = str(parsed.get("label") or "").strip().strip('"')
        out_desc = str(parsed.get("description") or "").strip()
        if not out_desc:
            return None
        return {"label": out_label[:80], "description": out_desc}
    except (KeyError, IndexError, json.JSONDecodeError) as exc:
        print(f"  Failed to parse Gemini response: {exc}")
        return None


def apply_modernized(record: Dict[str, Any], modernized: Dict[str, str]) -> None:
    if modernized.get("label"):
        record["label"] = modernized["label"]
    record["description"] = modernized["description"]
    if not isinstance(record.get("metadata"), dict):
        record["metadata"] = {}
    record["metadata"]["display_cleaned"] = True
    record["metadata"]["description_modernized"] = True


def needs_description_rewrite(record: Dict[str, Any]) -> bool:
    """True when description is missing, generic, or much shorter than the original."""
    original = original_spelling(record)
    if not original:
        return False
    description = str(record.get("description") or "").strip()
    meta = record.get("metadata") or {}
    if not description:
        return True
    if GENERIC_SUMMARY_RE.match(description):
        return True
    if len(description) < len(original) * 0.45:
        return True
    if not meta.get("description_modernized"):
        return True
    return False


def process_records(
    records: List[Dict[str, Any]],
    api_key: str,
    model: str,
    cache: Dict[str, Any],
    force: bool,
    dry_run: bool,
    limit: Optional[int],
    on_checkpoint: Optional[Callable[[], None]] = None,
) -> Tuple[int, int]:
    updated = 0
    skipped = 0
    for record in records:
        if stop_requested():
            break
        if limit is not None and updated >= limit:
            break
        rid = str(record.get("id") or record.get("label") or "unknown")
        original = original_spelling(record)
        if not original:
            skipped += 1
            continue
        if not force and not needs_description_rewrite(record):
            skipped += 1
            continue

        key = cache_key(rid, original)
        if not force and key in cache:
            modernized = cache[key]
        else:
            print(f"  Modernizing: {rid[:70]}", flush=True)
            if dry_run:
                updated += 1
                continue
            modernized = modernize_with_gemini(
                str(record.get("label") or ""), original, api_key, model
            )
            if not modernized:
                skipped += 1
                continue
            cache[key] = modernized
            save_cache(cache)
            time.sleep(0.4)

        if dry_run:
            continue
        apply_modernized(record, modernized)
        updated += 1
        if on_checkpoint is not None:
            on_checkpoint()
    return updated, skipped


def write_json_atomic(path: Path, data: Any) -> None:
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(path)


def process_local_json_dir(
    json_dir: Path,
    api_key: str,
    model: str,
    cache: Dict[str, Any],
    force: bool,
    dry_run: bool,
    limit: Optional[int],
) -> int:
    page_files = sorted(p for p in json_dir.glob("*.json") if p.name != "all_records.json")
    total_updated = 0
    remaining = limit

    for page_file in page_files:
        if stop_requested():
            break
        if remaining is not None and remaining <= 0:
            break
        with page_file.open("r", encoding="utf-8") as f:
            records = json.load(f)
        if not isinstance(records, list):
            continue
        print(f"\n{page_file.name} ({len(records)} records)", flush=True)

        def checkpoint() -> None:
            write_json_atomic(page_file, records)
            combined = rebuild_all_records(json_dir)
            print(f"  checkpoint saved; all_records.json now {combined}", flush=True)

        updated, _ = process_records(
            records, api_key, model, cache, force, dry_run, remaining, on_checkpoint=checkpoint
        )
        total_updated += updated
        if remaining is not None:
            remaining -= updated
        if stop_requested():
            break

    if not dry_run:
        combined = rebuild_all_records(json_dir)
        if combined:
            print(f"\nRebuilt all_records.json ({combined} records).")
    return total_updated


def process_single_file(
    path: Path,
    api_key: str,
    model: str,
    cache: Dict[str, Any],
    force: bool,
    dry_run: bool,
    limit: Optional[int],
) -> int:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        print(f"{path} is not a JSON array.")
        return 0
    print(f"\n{path} ({len(data)} records)", flush=True)

    def checkpoint() -> None:
        write_json_atomic(path, data)

    updated, skipped = process_records(
        data, api_key, model, cache, force, dry_run, limit, on_checkpoint=checkpoint
    )
    if not dry_run:
        write_json_atomic(path, data)
    print(f"Updated {updated}, skipped {skipped}.")
    return updated


def main() -> int:
    load_env_file()
    parser = argparse.ArgumentParser(description="Modernize record descriptions from original_spelling")
    parser.add_argument("--input", type=Path, help="Single JSON file (array of records)")
    parser.add_argument("--local", action="store_true", help=f"Process {LOCAL_JSON_DIR}")
    parser.add_argument("--newspapers", action="store_true", help=f"Process {NEWSPAPERS_JSON}")
    parser.add_argument("--force", action="store_true", help="Ignore description rewrite cache")
    parser.add_argument("--dry-run", action="store_true", help="Count work without writing or calling API")
    parser.add_argument("--limit", type=int, default=0, help="Max records to rewrite (0 = all)")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Gemini model (default: {DEFAULT_MODEL})")
    args = parser.parse_args()

    if not args.input and not args.local and not args.newspapers:
        parser.error("Specify --input, --local, and/or --newspapers")

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key and not args.dry_run:
        print("GEMINI_API_KEY is required (set in .env or environment).")
        return 1

    if not args.dry_run:
        install_stop_handler()

    cache = load_cache()
    record_limit: Optional[int] = args.limit if args.limit > 0 else None
    total = 0

    if args.local:
        total += process_local_json_dir(
            LOCAL_JSON_DIR, api_key or "", args.model, cache, args.force, args.dry_run, record_limit
        )
    if not stop_requested() and args.newspapers and NEWSPAPERS_JSON.exists():
        remaining = (record_limit - total) if record_limit is not None else None
        if record_limit is None or (remaining is not None and remaining > 0):
            total += process_single_file(
                NEWSPAPERS_JSON,
                api_key or "",
                args.model,
                cache,
                args.force,
                args.dry_run,
                remaining,
            )
    if not stop_requested() and args.input:
        remaining = (record_limit - total) if record_limit is not None else None
        if record_limit is None or (remaining is not None and remaining > 0):
            total += process_single_file(
                args.input, api_key or "", args.model, cache, args.force, args.dry_run, remaining
            )

    if stop_requested():
        print(f"\nStopped early. {total} record(s) saved; re-run to continue.")
    else:
        print(f"\nDone. {total} record(s) {'would be ' if args.dry_run else ''}modernized.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
