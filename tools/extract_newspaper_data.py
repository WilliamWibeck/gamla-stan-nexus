#!/usr/bin/env python3
"""Extract structured historical information from old Swedish newspaper scans and clippings.

Inputs:
1) Images (.jpg, .jpeg, .png) in data_sources/images/ — transcribed and structured via the
   Gemini multimodal API.
2) Text clippings (.txt) in data_sources/clippings/ — parsed with regexes.

Extraction results for images are cached per file (keyed by content hash) in
data_sources/.extraction_cache.json, so re-runs only send new or changed scans to the API
and previously extracted records survive network failures. Geocoding and metadata shaping
are re-applied from the cached raw records on every run, so improvements to that logic
take effect without new API calls.

Output: data_sources/extracted_newspapers.json, consumed by tools/build_nexus_master.py.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import requests
except ModuleNotFoundError:
    print("Error: The 'requests' library is required to run this script.")
    print("Please install it by running: pip install requests")
    sys.exit(1)

PROJECT_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
# Bump when the extraction prompt changes so cached raw records are refreshed.
PROMPT_VERSION = 2
DONE_DIR_NAME = "done"

# Coordinates used when no gazetteer entry matches (Stortorget, the district center).
DISTRICT_FALLBACK = (59.3254, 18.0703)

# Pre-defined coordinates for common historic streets, squares, and buildings in Gamla Stan.
# Keys may be written with diacritics; matching is done on a diacritic-folded form.
GAMLA_STAN_GAZETTEER = {
    "stortorget": (59.3254, 18.0703),
    "järntorget": (59.3236, 18.0679),
    "jern-torget": (59.3236, 18.0679),
    "österlånggatan": (59.3256, 18.0722),
    "västerlånggatan": (59.3253, 18.0681),
    "stora nygatan": (59.3250, 18.0672),
    "lilla nygatan": (59.3251, 18.0664),
    "svartmangatan": (59.3248, 18.0701),
    "skomakargatan": (59.3250, 18.0697),
    "kindstugatan": (59.3245, 18.0712),
    "köpmangatan": (59.3253, 18.0717),
    "själagårdsgatan": (59.3246, 18.0718),
    "baggensgatan": (59.3249, 18.0729),
    "prästgatan": (59.32450, 18.07029),
    "svenska prästgatan": (59.32450, 18.07029),
    "göran hälsinges gränd": (59.32520, 18.06849),
    "skeppsbron": (59.32525, 18.0756),
    "kråkgränd": (59.32533, 18.07475),
    "kråkgränden": (59.32533, 18.07475),
    "gaffelgränd": (59.3240, 18.0750),
    "nygränd": (59.32495, 18.0752),
    "slottsbacken": (59.3268, 18.0712),
    "trångsund": (59.3252, 18.0708),
    "munkbron": (59.3260, 18.0658),
    "munkbrogatan": (59.3239, 18.0676),
    "myntgatan": (59.3265, 18.0680),
    "mälartorget": (59.3232, 18.0686),
    "storkyrkobrinken": (59.3258, 18.0670),
    "kungliga slottet": (59.3269, 18.0717),
    "kongl. slottet": (59.3269, 18.0717),
    "stockholms slott": (59.3269, 18.0717),
    "slottet": (59.3269, 18.0717),
    "riddarhuset": (59.3262, 18.0654),
    "riddarhus-torget": (59.3262, 18.0654),
    "mynttorget": (59.32675, 18.06893),
    "lilla mynttorget": (59.32675, 18.06893),
    "operahuset": (59.3297, 18.0706),
    "operan": (59.3297, 18.0706),
    "skeppar olofs gränd": (59.3255, 18.0715),
    "poliskammaren": (59.3255, 18.0715),
    "tyska kyrkan": (59.3245, 18.0709),
    "storkyrkan": (59.3258, 18.0704),
    "kornhamnstorg": (59.3228, 18.0684),
    "brända tomten": (59.3247, 18.0716),
    "gåsgränd": (59.3251, 18.0669),
    "drakens gränd": (59.3247, 18.0733),
    "mårten trotzigs gränd": (59.3229, 18.0727),
    "stora gråmunkegränd": (59.3252, 18.0671),
    "lilla gråmunkegränd": (59.3250, 18.0675),
    "bredgränd": (59.3256, 18.0748),
    "ferkens gränd": (59.3242, 18.0748),
    "ignatiigränd": (59.3251, 18.0686),
    "stallplan": (59.3233, 18.0729),
    "tyska brinken": (59.3247, 18.0687),
    "kåkbrinken": (59.3258, 18.0678),
    "riddarholmen": (59.3249, 18.0630),
}


def load_env_file() -> None:
    """Load GEMINI_API_KEY / GEMINI_MODEL from a .env file if present."""
    for path in [PROJECT_ROOT / ".env", Path(".env")]:
        if not path.exists():
            continue
        try:
            with path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    key = k.strip()
                    if key in ("GEMINI_API_KEY", "GEMINI_MODEL") and key not in os.environ:
                        os.environ[key] = v.strip().strip('"').strip("'")
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Text normalization & geocoding
# ---------------------------------------------------------------------------

def clean_swedish_spelling(text: str) -> str:
    """Normalize old Swedish spelling variants to facilitate matching."""
    text_lower = text.lower()
    replacements = {
        "af ": "av ",
        "blef": "blev",
        "dher": "där",
        "hwar": "var",
        "hwad": "vad",
        "kongl.": "kungliga",
        "qwinn": "qvinn",
        "wid ": "vid ",
        "gränden": "gränd",
    }
    for old, new in replacements.items():
        text_lower = text_lower.replace(old, new)
    return text_lower


def fold_diacritics(text: str) -> str:
    return (
        text.replace("å", "a")
        .replace("ä", "a")
        .replace("ö", "o")
        .replace("é", "e")
        .replace("ü", "u")
    )


def normalize_for_match(text: str) -> str:
    """Lowercase, fold diacritics, and collapse whitespace for gazetteer matching."""
    out = fold_diacritics(text.lower())
    return re.sub(r"\s+", " ", out).strip()


# Normalized gazetteer, longest keys first so "kungliga slottet" wins over "slottet".
_GAZETTEER_NORMALIZED: List[Tuple[str, str, Tuple[float, float]]] = sorted(
    ((normalize_for_match(key), key, coords) for key, coords in GAMLA_STAN_GAZETTEER.items()),
    key=lambda item: -len(item[0]),
)


def geocode_texts(*texts: Optional[str]) -> Tuple[float, float, Optional[str], str]:
    """Match the first gazetteer entry found in any of the given texts.

    Returns (lat, lng, matched_place_name, geocode_status) where geocode_status is
    "matched" or "district_fallback".
    """
    for text in texts:
        if not text:
            continue
        haystack = normalize_for_match(clean_swedish_spelling(str(text)))
        for norm_key, display_key, (lat, lng) in _GAZETTEER_NORMALIZED:
            if norm_key in haystack:
                return lat, lng, display_key.title(), "matched"
    lat, lng = DISTRICT_FALLBACK
    return lat, lng, None, "district_fallback"


# ---------------------------------------------------------------------------
# Extraction cache
# ---------------------------------------------------------------------------

def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_cache(cache_path: Path) -> Dict[str, Any]:
    if cache_path.exists():
        try:
            with cache_path.open("r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("images"), dict):
                return data
        except Exception as e:
            print(f"Warning: could not read extraction cache ({e}); starting fresh.")
    return {"images": {}}


def save_cache(cache_path: Path, cache: Dict[str, Any]) -> None:
    tmp_path = cache_path.with_suffix(".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)
    tmp_path.replace(cache_path)


def archive_processed_image(img_path: Path, done_dir: Path) -> Optional[Path]:
    """Move a processed scan out of the inbox into done_dir."""
    if not img_path.exists():
        return None
    if img_path.resolve().parent == done_dir.resolve():
        return img_path
    done_dir.mkdir(parents=True, exist_ok=True)
    dest = done_dir / img_path.name
    if dest.exists():
        stem, suffix = img_path.stem, img_path.suffix
        n = 2
        while dest.exists():
            dest = done_dir / f"{stem}_{n}{suffix}"
            n += 1
    shutil.move(str(img_path), str(dest))
    return dest


def tracked_image_names(images_path: Path) -> set[str]:
    """Filenames still accounted for in the inbox or the done archive."""
    names: set[str] = set()
    for ext in ("*.jpg", "*.jpeg", "*.png"):
        for path in images_path.glob(ext):
            names.add(path.name)
    done_dir = images_path / DONE_DIR_NAME
    if done_dir.is_dir():
        for ext in ("*.jpg", "*.jpeg", "*.png"):
            for path in done_dir.glob(ext):
                names.add(path.name)
    return names


# ---------------------------------------------------------------------------
# Gemini extraction
# ---------------------------------------------------------------------------

EXTRACTION_PROMPT = """
You are an expert Swedish historical archivist.
Your task is to analyze the attached historical Swedish document (which could be a newspaper page, police blotter, fire record, parish registry, or court record) from the 17th to 19th century and extract historical events, people, and locations.

Extract each event, notice, entry, or report as a structured object with the following fields:
- label: A brief, evocative title in Swedish or English for the event (e.g., "Polisrapport: Stöld vid Svartmangatan", "Eldsvåda: Kvarteret Cepheus", "Tidningsnotis: Olof Berg", "Vigsel i Storkyrkan").
- date: The date of the event in YYYY-MM-DD format (or just YYYY if the exact date isn't clear from the text).
- address: The specific street name, alley (gränd), square (torg), or quarter (kvarter) mentioned, exactly as it can be located in Stockholm's Gamla Stan (e.g., "Stortorget", "Svartmangatan", "Skeppsbron"). If none is mentioned, return null. Do NOT guess.
- description: A full modern Swedish rendering of the notice (same facts as original_text, updated
  spelling and grammar — NOT a short summary of what happened).
- resident: The full name of the primary historical person mentioned in the notice (e.g., "Olof Berg") or null if none.
- theme: The theme of the notice. Choose exactly one of: "Daily Life", "Security Threats", "Court & State", "Conspiracy". If it is a police record, choose "Security Threats". If it is a fire record, choose "Security Threats" or "Daily Life".
- record_type: The type of document this was extracted from. Choose one of: "Newspaper", "Police Record", "Fire Record", "Parish Record", "Other".
- source_paper: The name of the newspaper or institution if visible in the document (e.g., "Inrikes Tidningar"), otherwise null.
- original_text: A faithful transcription (with original 18th-century spelling) of the source passage for this event, as far as legible.
- crime: (for police records) the type of crime (e.g., "Stöld", "Fylleri", "Misshandel") or null if not applicable.
- suspect: (for police records) name of suspect/perpetrator or null if not applicable.
- victim: (for police records) name of victim or null if not applicable.
- fire_cause: (for fire records) cause of the fire or null if not applicable.
- damage_level: (for fire records) description of damages or null if not applicable.
- parish_event: (for parish records) type of event (e.g., "Dop", "Vigsel", "Begravning") or null if not applicable.

Return the output strictly as a JSON array of objects.
"""

RETRYABLE_STATUS = {429, 500, 502, 503, 504}


def extract_with_gemini(
    image_path: Path, api_key: str, model: str, max_attempts: int = 4
) -> Optional[List[Dict[str, Any]]]:
    """Transcribe and structure a scan via Gemini.

    Returns a list of raw records, or None on failure (so the caller can avoid
    caching a failed attempt as an empty result).
    """
    try:
        with image_path.open("rb") as f:
            img_data = base64.b64encode(f.read()).decode("utf-8")
    except Exception as e:
        print(f"Error reading image {image_path.name}: {e}")
        return None

    mime_type = "image/png" if image_path.suffix.lower() == ".png" else "image/jpeg"
    urls = [
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}",
        f"https://generativelanguage.googleapis.com/v1/models/{model}:generateContent?key={api_key}",
    ]

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": EXTRACTION_PROMPT},
                    {"inline_data": {"mime_type": mime_type, "data": img_data}},
                ]
            }
        ],
        "generation_config": {"response_mime_type": "application/json"},
    }

    print(f"Sending {image_path.name} to {model}...")
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
                wait = 2 ** attempt
                print(
                    f"  Transient API error {response.status_code}; retrying in {wait}s "
                    f"(attempt {attempt}/{max_attempts})..."
                )
                time.sleep(wait)
                continue
            break
        except requests.RequestException as e:
            wait = 2 ** attempt
            print(f"  Network error ({e}); retrying in {wait}s (attempt {attempt}/{max_attempts})...")
            time.sleep(wait)
            response = None

    if response is None or response.status_code != 200:
        status = response.status_code if response is not None else "no response"
        body = response.text[:300] if response is not None else ""
        print(f"API error for {image_path.name} ({status}): {body}")
        return None

    try:
        res_data = response.json()
        candidates = res_data.get("candidates") or []
        if not candidates:
            print(f"No candidates returned for {image_path.name}.")
            return None
        text_content = candidates[0]["content"]["parts"][0]["text"].strip()
        if text_content.startswith("```"):
            text_content = re.sub(r"^```(?:json)?\s*", "", text_content)
            text_content = re.sub(r"\s*```$", "", text_content)
        extracted = json.loads(text_content.strip())
        if isinstance(extracted, dict):
            extracted = [extracted]
        if not isinstance(extracted, list):
            print(f"Unexpected response shape for {image_path.name}.")
            return None
        return [rec for rec in extracted if isinstance(rec, dict)]
    except Exception as e:
        print(f"Failed to parse Gemini response for {image_path.name}: {e}")
        return None


def postprocess_image_record(raw: Dict[str, Any], archive_ref: str) -> Dict[str, Any]:
    """Shape a raw Gemini record into the extracted_newspapers.json schema, with geocoding."""
    rec = dict(raw)
    address = rec.get("address")
    description = rec.get("description")
    lat, lng, matched_place, geocode_status = geocode_texts(address, description)

    rec["lat"] = lat
    rec["lng"] = lng
    if not address:
        rec["address"] = matched_place or "Gamla Stan"

    theme = rec.pop("theme", None) or "Daily Life"
    original_text = rec.pop("original_text", None)
    source_paper = rec.pop("source_paper", None)

    metadata = rec.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
    metadata.update(
        {
            "source_paper": source_paper or metadata.get("source_paper") or "Unknown",
            "archive_ref": archive_ref,
            "original_spelling": original_text or rec.get("description", ""),
            "themes": [theme],
            "record_type": rec.pop("record_type", None) or "Newspaper",
            "crime": rec.pop("crime", None),
            "suspect": rec.pop("suspect", None),
            "victim": rec.pop("victim", None),
            "fire_cause": rec.pop("fire_cause", None),
            "damage_level": rec.pop("damage_level", None),
            "parish_event": rec.pop("parish_event", None),
            "geocode_status": geocode_status,
            "location_approximate": geocode_status != "matched",
        }
    )
    rec["metadata"] = metadata
    return rec


# ---------------------------------------------------------------------------
# Text clipping extraction (regex)
# ---------------------------------------------------------------------------

def extract_clipping_regex(text: str, filename: str) -> Dict[str, Any]:
    """Parse structured text clippings (DATE:/SOURCE:/CONTENT: headers) into a record."""
    def field(name: str) -> Optional[str]:
        m = re.search(rf"{name}:\s*([^\n]+)", text, re.IGNORECASE)
        return m.group(1).strip() if m else None

    date_match = re.search(r"DATE:\s*(\d{4}-\d{2}-\d{2}|\d{4})", text, re.IGNORECASE)
    content_match = re.search(r"CONTENT:\s*(.*)", text, re.IGNORECASE | re.DOTALL)

    date_str = date_match.group(1) if date_match else "1790"
    source = field("SOURCE") or "Unknown Source"
    doc_type = field("TYPE") or "Newspaper"
    address_field = field("ADDRESS")
    crime = field("CRIME")
    suspect = field("SUSPECT")
    victim = field("VICTIM")
    fire_cause = field("FIRE_CAUSE")
    damage_level = field("DAMAGE_LEVEL")
    parish_event = field("PARISH_EVENT")
    content = content_match.group(1).strip() if content_match else text.strip()

    lat, lng, matched_place, geocode_status = geocode_texts(address_field, content)
    detected_address = matched_place or address_field or "Gamla Stan"

    normalized_content = clean_swedish_spelling(content)

    # Extract names: explicit fields first, then heuristics.
    names_found: List[str] = []
    if suspect:
        names_found.append(suspect)
    if victim:
        names_found.append(victim)
    if not names_found:
        name_phrase = re.search(
            r"(?:namn|gesäll|jungfru|herrn|madame|kapten)\s+([A-ZÅÄÖ][a-zåäöé]+(?:\s+[A-ZÅÄÖ][a-zåäöé]+)+)",
            content,
        )
        if name_phrase:
            names_found.append(name_phrase.group(1).strip())
        else:
            pairs = re.findall(r"\b([A-ZÅÄÖ][a-zåäöé]+\s+[A-ZÅÄÖ][a-zåäöé]+)\b", content)
            for p in pairs:
                if not any(
                    stop in p
                    for stop in ["Stortorget", "Tyska", "Gamla", "Skeppar", "Stockholm", "Inrikes"]
                ):
                    names_found.append(p.strip())

    primary_person = names_found[0] if names_found else "Okänd person"

    event_label = f"Tidningsnotis: {primary_person} ({date_str})"
    theme = "Daily Life"

    is_police = (
        doc_type.lower() == "police record"
        or "polis" in normalized_content
        or "arrest" in normalized_content
        or crime
        or suspect
    )
    is_fire = (
        doc_type.lower() == "fire record"
        or "brand" in normalized_content
        or "eldsvåda" in normalized_content
        or fire_cause
    )
    is_parish = (
        doc_type.lower() == "parish record"
        or "dop" in normalized_content
        or "vigsel" in normalized_content
        or parish_event
    )

    if is_police:
        event_label = f"Polisrapport: {primary_person} ({date_str})"
        theme = "Security Threats"
        doc_type = doc_type if doc_type.lower() != "newspaper" else "Police Record"
    elif is_fire:
        event_label = f"Eldsvåda: {detected_address} ({date_str})"
        theme = "Security Threats"
        doc_type = doc_type if doc_type.lower() != "newspaper" else "Fire Record"
    elif is_parish:
        event_label = f"Församlingsnotis: {primary_person} ({date_str})"
        theme = "Daily Life"
        doc_type = doc_type if doc_type.lower() != "newspaper" else "Parish Record"

    return {
        "label": event_label,
        "date": date_str,
        "lat": lat,
        "lng": lng,
        "address": detected_address,
        "description": content,
        "resident": primary_person if names_found else None,
        "metadata": {
            "source_paper": source,
            "archive_ref": filename,
            "original_spelling": content,
            "themes": [theme],
            "record_type": doc_type,
            "crime": crime,
            "suspect": suspect,
            "victim": victim,
            "fire_cause": fire_cause,
            "damage_level": damage_level,
            "parish_event": parish_event,
            "geocode_status": geocode_status,
            "location_approximate": geocode_status != "matched",
        },
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def warn_suspicious_dates(records: List[Dict[str, Any]]) -> None:
    for rec in records:
        date = str(rec.get("date") or "")
        m = re.match(r"^(\d{4})", date)
        if m:
            year = int(m.group(1))
            if year < 1600 or year > 1900:
                print(
                    f"Warning: '{rec.get('label')}' is dated {year} — outside the expected "
                    f"1600–1900 range (source: {rec.get('metadata', {}).get('archive_ref')})."
                )


def dedupe_records(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    out = []
    for rec in records:
        key = (
            str(rec.get("label")),
            str(rec.get("date")),
            str(rec.get("metadata", {}).get("archive_ref")),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(rec)
    return out


def main() -> int:
    load_env_file()

    default_images_dir = PROJECT_ROOT / "data_sources" / "images"
    default_clippings_dir = PROJECT_ROOT / "data_sources" / "clippings"
    default_output = PROJECT_ROOT / "data_sources" / "extracted_newspapers.json"
    default_cache = PROJECT_ROOT / "data_sources" / ".extraction_cache.json"

    parser = argparse.ArgumentParser(
        description="Extract structured data from historical newspaper scans and clippings"
    )
    parser.add_argument("--images-dir", default=str(default_images_dir))
    parser.add_argument("--clippings-dir", default=str(default_clippings_dir))
    parser.add_argument("--output", default=str(default_output))
    parser.add_argument("--cache", default=str(default_cache))
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"Gemini model id (default: {DEFAULT_MODEL}; also via GEMINI_MODEL env)",
    )
    parser.add_argument(
        "--api-key",
        default=os.getenv("GEMINI_API_KEY"),
        help="Gemini API key (can also be set via GEMINI_API_KEY env variable or .env)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Ignore the extraction cache and reprocess all images",
    )
    parser.add_argument(
        "--no-archive",
        action="store_true",
        help="Leave processed scans in the images folder (default: move to images/done/)",
    )
    args = parser.parse_args()

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path = Path(args.cache)
    cache = load_cache(cache_path)

    images_path = Path(args.images_dir)
    images_path.mkdir(parents=True, exist_ok=True)
    done_dir = images_path / DONE_DIR_NAME
    image_files = sorted(
        p for ext in ("*.jpg", "*.jpeg", "*.png") for p in images_path.glob(ext)
    )

    counts = {"cached": 0, "extracted": 0, "failed": 0, "skipped_no_key": 0, "archived": 0}

    # 1) Images: reuse cache when the file hash and prompt version match, else call Gemini.
    for img_file in image_files:
        digest = file_sha256(img_file)
        entry = cache["images"].get(img_file.name)
        cache_valid = (
            not args.force
            and entry is not None
            and entry.get("sha256") == digest
            and entry.get("prompt_version") == PROMPT_VERSION
        )
        if cache_valid:
            counts["cached"] += 1
            if not args.no_archive:
                dest = archive_processed_image(img_file, done_dir)
                if dest:
                    counts["archived"] += 1
                    print(f"Archived cached scan -> {dest.relative_to(images_path)}")
            continue
        if not args.api_key:
            counts["skipped_no_key"] += 1
            continue
        raw_records = extract_with_gemini(img_file, args.api_key, args.model)
        if raw_records is None:
            counts["failed"] += 1
            print(f"Keeping previous extraction for {img_file.name} (if any).")
            continue
        cache["images"][img_file.name] = {
            "sha256": digest,
            "model": args.model,
            "prompt_version": PROMPT_VERSION,
            "extracted_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "records": raw_records,
        }
        counts["extracted"] += 1
        print(f"Extracted {len(raw_records)} record(s) from {img_file.name}.")
        # Persist after every image so an interrupted batch never loses paid API results.
        save_cache(cache_path, cache)
        if not args.no_archive:
            dest = archive_processed_image(img_file, done_dir)
            if dest:
                counts["archived"] += 1
                print(f"Archived -> {dest.relative_to(images_path)}")

    # Drop cache entries for images removed from both inbox and done/.
    present_names = tracked_image_names(images_path)
    removed = [name for name in cache["images"] if name not in present_names]
    for name in removed:
        del cache["images"][name]
        print(f"Removed cached extraction for deleted image: {name}")

    save_cache(cache_path, cache)

    if counts["skipped_no_key"]:
        print(
            f"Note: {counts['skipped_no_key']} image(s) skipped — no Gemini API key. "
            "Set GEMINI_API_KEY in .env to process them."
        )

    # 2) Build output records: post-process cached raw image records + parse clippings.
    extracted_records: List[Dict[str, Any]] = []
    for name in sorted(cache["images"]):
        for raw in cache["images"][name].get("records", []):
            extracted_records.append(postprocess_image_record(raw, name))

    clippings_path = Path(args.clippings_dir)
    clippings_path.mkdir(parents=True, exist_ok=True)
    text_files = sorted(clippings_path.glob("*.txt"))
    for txt_file in text_files:
        try:
            content = txt_file.read_text(encoding="utf-8")
            if content.strip():
                record = extract_clipping_regex(content, txt_file.name)
                extracted_records.append(record)
                print(f"Processed {txt_file.name} -> {record['label']} at {record['address']}")
        except Exception as e:
            print(f"Error processing text file {txt_file.name}: {e}")

    extracted_records = dedupe_records(extracted_records)
    warn_suspicious_dates(extracted_records)

    if not extracted_records:
        print(
            "\nNo records extracted. Place JPG/PNG scans in data_sources/images/ "
            "or TXT files in data_sources/clippings/"
        )
        return 0

    with output_path.open("w", encoding="utf-8") as f:
        json.dump(extracted_records, f, ensure_ascii=False, indent=2)

    unmatched = sum(
        1
        for r in extracted_records
        if r.get("metadata", {}).get("geocode_status") == "district_fallback"
    )
    print(
        f"\nWrote {len(extracted_records)} records to {output_path} "
        f"(images: {counts['extracted']} newly extracted, {counts['cached']} from cache, "
        f"{counts['failed']} failed, {counts['archived']} archived; clippings: {len(text_files)})."
    )
    if unmatched:
        print(
            f"{unmatched} record(s) had no gazetteer match and use the district-center fallback "
            "(flagged location_approximate in metadata)."
        )
    print("Next step: python tools/build_nexus_master.py  (or use tools/run_pipeline.py)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
