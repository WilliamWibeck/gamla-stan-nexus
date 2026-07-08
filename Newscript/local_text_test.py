#!/usr/bin/env python3
"""Local OCR + structured extraction pipeline for 18th-century Swedish newspapers.

Runs fully offline against an Ollama vision model (default qwen2.5vl:7b) and turns
page scans into search-ready structured records:

  1. TILING      - each page is split into column-aware tiles at readable
                   resolution (whole pages downscale Fraktur into mush).
  2. OCR         - each tile is transcribed verbatim (vision call per tile),
                   tiles are stitched back with seam de-duplication.
  3. SEGMENT     - the page text is split into individual notices
                   (schema-enforced JSON, so no parse failures).
  4. EXTRACT     - each notice gets its own small extraction call with a strict
                   JSON schema: label, category (fixed enum), date, address,
                   people (name + role), locations, crime/fire/parish details.
  5. NORMALIZE   - deterministic post-processing: dates resolved against the
                   issue date from the KB filename, tiered geocoding (historic
                   Stockholm gazetteer -> OSM/Nominatim lookup with local cache
                   -> district fallback), person roles split from names,
                   category keyword fallback, stable record ids.
  6. MODERNIZE   - description rewritten from original_spelling in modern Swedish
                   (same content, updated spelling — never a summary).

Outputs:
  output_text/<page>.txt      raw OCR transcription (full-text search corpus)
  output_json/<page>.json     structured records for one page
  output_json/all_records.json  combined, ready for filtering/search indexing

The record shape matches data_sources/extracted_newspapers.json, so results can
be fed straight into tools/build_nexus_master.py.

Usage:
  python local_text_test.py                 # process ./input_pages
  python local_text_test.py --limit 2       # only 2 pages (quick test; safe to stop anytime)
  python local_text_test.py --refresh       # re-geocode + clean existing JSON, no OCR

Processed page scans are moved to <input>/done/ by default (use --no-archive to keep them).
Ctrl+C stops after the current notice; completed pages are checkpointed to disk immediately.
"""

from __future__ import annotations

import argparse
import difflib
import io
import json
import math
import re
import shutil
import signal
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image, ImageOps

try:
    from ollama import chat
except ModuleNotFoundError:
    chat = None  # checked in main(); pure functions stay importable/testable

SCRIPT_DIR = Path(__file__).resolve().parent

# --- graceful shutdown (Ctrl+C keeps completed checkpoints) --------------------

_STOP_REQUESTED = False


def install_stop_handler() -> None:
    def _handler(signum: int, _frame: Any) -> None:
        global _STOP_REQUESTED
        if _STOP_REQUESTED:
            print("\nForce quit.", flush=True)
            raise SystemExit(130)
        _STOP_REQUESTED = True
        print(
            "\nStop requested — finishing current notice, saving checkpoints, then exiting.",
            flush=True,
        )

    signal.signal(signal.SIGINT, _handler)
    signal.signal(signal.SIGTERM, _handler)


def stop_requested() -> bool:
    return _STOP_REQUESTED


def page_json_path(json_dir: Path, stem: str) -> Path:
    return json_dir / f"{stem}.json"


def page_partial_marker(json_dir: Path, stem: str) -> Path:
    return json_dir / f"{stem}.partial"


def page_complete_marker(json_dir: Path, stem: str) -> Path:
    return json_dir / f"{stem}.complete"


def page_is_complete(json_dir: Path, stem: str) -> bool:
    """True when a page JSON exists and is not marked as an interrupted partial run."""
    json_path = page_json_path(json_dir, stem)
    if not json_path.exists():
        return False
    if page_complete_marker(json_dir, stem).exists():
        return True
    if page_partial_marker(json_dir, stem).exists():
        return False
    # Legacy outputs from before checkpoint markers: treat as complete.
    return True


def mark_page_started(json_dir: Path, stem: str) -> None:
    page_partial_marker(json_dir, stem).write_text("in_progress\n", encoding="utf-8")


def mark_page_complete(json_dir: Path, stem: str) -> None:
    partial = page_partial_marker(json_dir, stem)
    if partial.exists():
        partial.unlink()
    page_complete_marker(json_dir, stem).write_text("ok\n", encoding="utf-8")


# --- configuration defaults -------------------------------------------------

DEFAULT_IMAGE_DIR = SCRIPT_DIR / "input_pages"
DEFAULT_DONE_DIR_NAME = "done"
DEFAULT_JSON_DIR = SCRIPT_DIR / "output_json"
DEFAULT_TEXT_DIR = SCRIPT_DIR / "output_text"
DEFAULT_MODEL = "qwen2.5vl:7b"
DEFAULT_CTX = 8192

# Known KB bibliographic ids -> newspaper title.
BIB_TO_PAPER = {
    "bib13506739": "Dagligt Allehanda",
    "bib11653806": "Inrikes Tidningar",
    "bib19225772": "Götheborgs Allehanda",
}

# Categories aligned with the Nexus app's filtering system (nexusCategories.ts).
CATEGORIES = ["crime", "fire", "court", "conspiracy", "church", "commerce", "foreign", "daily"]
CATEGORY_LABELS = {
    "crime": "Crime & Justice",
    "fire": "Fires & Accidents",
    "court": "Court & State",
    "conspiracy": "Conspiracy",
    "church": "Church & Parish",
    "commerce": "Trade & Notices",
    "foreign": "Foreign Dispatches",
    "daily": "City Life",
}

# --- gazetteer (historic Stockholm) -------------------------------------------
# Curated coordinates for streets, squares and NAMED buildings/institutions that
# appear in 1700s notices. Extends the Gamla Stan gazetteer from
# tools/extract_newspaper_data.py with Norrmalm, Kungsholmen, Södermalm and
# Ladugårdslandet. Old spellings (Kongsholm, Jern-) are included as aliases.

DISTRICT_FALLBACK = (59.3254, 18.0703)  # Stortorget
# Gamla stan — reject OSM hits outside this when geocoding old-town streets.
GAMLA_STAN_BBOX = (18.063, 59.321, 18.078, 59.329)  # min lng, min lat, max lng, max lat

STOCKHOLM_GAZETTEER: Dict[str, Tuple[float, float]] = {
    "stortorget": (59.32500, 18.07082),
    "järntorget": (59.3236, 18.0679),
    "jern-torget": (59.3236, 18.0679),
    "österlånggatan": (59.32424, 18.07386),
    "västerlånggatan": (59.32466, 18.06971),
    "stora nygatan": (59.32421, 18.06922),
    "lilla nygatan": (59.32347, 18.06918),
    "svartmangatan": (59.3248, 18.0701),
    "skomakargatan": (59.32440, 18.07087),
    "kindstugatan": (59.3245, 18.0712),
    "köpmangatan": (59.32510, 18.07234),
    "själagårdsgatan": (59.3246, 18.0718),
    "baggensgatan": (59.32490, 18.07346),
    "prästgatan": (59.32450, 18.07029),
    "svenska prästgatan": (59.32450, 18.07029),
    "swenska prästgatan": (59.32450, 18.07029),
    "göran hälsinges gränd": (59.32520, 18.06849),
    "goran halsinges grand": (59.32520, 18.06849),
    # Skeppsbron & eastern waterfront (lng ≈ 18.075–18.076 on the quay, NOT Österlånggatan)
    "skeppsbron": (59.32379, 18.07541),
    "slottsbacken": (59.3268, 18.0712),
    "gaffelgränd": (59.3240, 18.0750),
    "gaffelgränden": (59.3240, 18.0750),
    "kråkgränd": (59.32533, 18.07475),
    "kråkgränden": (59.32533, 18.07475),
    "kraekgraend": (59.32533, 18.07475),
    "nygränd": (59.32495, 18.0752),
    "nygränden": (59.32495, 18.0752),
    "pelikans gränd": (59.32555, 18.0726),
    "pelikansgränd": (59.32555, 18.0726),
    "saltkompanigränd": (59.32545, 18.0729),
    "saltcompagnie gränd": (59.32545, 18.0729),
    "brunnsgränd": (59.32505, 18.0750),
    "tessinska palatset": (59.32585, 18.0748),
    "munkbron": (59.3260, 18.0658),
    "munkbro-torget": (59.3260, 18.0658),
    "munkbrogatan": (59.3239, 18.0676),
    "myntgatan": (59.3265, 18.0680),
    "mynttorget": (59.32675, 18.06893),
    "lilla mynttorget": (59.32675, 18.06893),
    "mälartorget": (59.3232, 18.0686),
    "storkyrkobrinken": (59.3258, 18.0670),
    "kungliga slottet": (59.3269, 18.0717),
    "kongl. slottet": (59.3269, 18.0717),
    "stockholms slott": (59.3269, 18.0717),
    "stockholms slottet": (59.3269, 18.0717),
    "slottet": (59.3269, 18.0717),
    "riddarhuset": (59.3262, 18.0654),
    "riddarhus-torget": (59.3262, 18.0654),
    "riddarhustorget": (59.3262, 18.0654),
    "operahuset": (59.3297, 18.0706),
    "operan": (59.3297, 18.0706),
    "skeppar olofs gränd": (59.3255, 18.0715),
    "poliskammaren": (59.3255, 18.0715),
    "tyska kyrkan": (59.3245, 18.0709),
    "storkyrkan": (59.3258, 18.0704),
    "kornhamnstorg": (59.3228, 18.0684),
    "brända tomten": (59.3247, 18.0716),
    "gåsgränd": (59.3251, 18.0669),
    "tyska brinken": (59.3247, 18.0687),
    "kåkbrinken": (59.3258, 18.0678),
    "riddarholmen": (59.3249, 18.0630),
    "söder sluss": (59.3222, 18.0716),
    "slussen": (59.3222, 18.0716),
    "börshuset": (59.3252, 18.0705),
    "bollhusgränden": (59.3262, 18.0723),
    "bollhuset": (59.3263, 18.0725),
    "drakens gränd": (59.32445, 18.07473),
    "mårten trotzigs gränd": (59.3229, 18.0727),
    "stora gråmunkegränd": (59.3252, 18.0671),
    "lilla gråmunkegränd": (59.3250, 18.0675),
    "bredgränd": (59.3256, 18.0748),
    "ferkens gränd": (59.3242, 18.0748),
    "ignatiigränd": (59.3251, 18.0686),
    "stallplan": (59.3233, 18.0729),
    # Norrmalm
    "regeringsgatan": (59.3330, 18.0697),
    "drottninggatan": (59.3330, 18.0628),
    "hötorget": (59.3348, 18.0636),
    "norrbro": (59.3282, 18.0703),
    "norrmalmstorg": (59.3296, 18.0687),  # 1700s name for today's Gustav Adolfs torg
    "gustav adolfs torg": (59.3296, 18.0687),
    "packartorget": (59.3330, 18.0745),   # today's Norrmalmstorg
    "brunkebergstorg": (59.3305, 18.0650),
    "rosenbad": (59.3290, 18.0663),
    "röda bodarne": (59.3285, 18.0630),
    "fredsgatan": (59.3288, 18.0650),
    "jakobsgatan": (59.3292, 18.0672),
    "malmtorgsgatan": (59.3300, 18.0660),
    "malmskillnadsgatan": (59.3330, 18.0665),
    "klara kyrka": (59.3313, 18.0603),
    "klara kyrkogård": (59.3313, 18.0603),
    "jakobs kyrka": (59.3298, 18.0702),
    "johannes kyrka": (59.3390, 18.0670),
    "adolf fredriks kyrka": (59.3390, 18.0580),
    "kungsträdgården": (59.3310, 18.0715),
    "kungsträdgärden": (59.3310, 18.0715),
    "arsenalsgatan": (59.3300, 18.0740),
    "stora barnhuset": (59.3370, 18.0570),
    "barnhuset": (59.3370, 18.0570),
    "observatorium": (59.34151, 18.05467),
    "kungliga myntet": (59.3270, 18.0500),
    # Kungsholmen
    "kungsholms bränneri": (59.3277, 18.0405),
    "kongsholms bränneri": (59.3277, 18.0405),
    "kungsholms kronobränneri": (59.3277, 18.0405),
    "kungsholms kyrka": (59.3283, 18.0440),
    "ulrika eleonora kyrka": (59.3283, 18.0440),
    "serafimerlasarettet": (59.3270, 18.0490),
    "serafimer-lasarettet": (59.3270, 18.0490),
    "kungsholmen": (59.3300, 18.0350),
    "kongsholmen": (59.3300, 18.0350),
    "kungsholmstorg": (59.3270, 18.0430),
    # Södermalm
    "götgatan": (59.3155, 18.0725),
    "hornsgatan": (59.3175, 18.0590),
    "katarina kyrka": (59.3171, 18.0776),
    "maria kyrka": (59.3187, 18.0630),
    "maria magdalena kyrka": (59.3187, 18.0630),
    "mosebacke": (59.3183, 18.0745),
    "stadsgården": (59.3200, 18.0780),
    "danviken": (59.3130, 18.1030),
    "besvärsgatan": (59.3196, 18.0710),   # today's Brunnsbacken/Katarinavägen area
    # Ladugårdslandet (Östermalm) & islands
    "ladugårdslandet": (59.3350, 18.0850),
    "hedvig eleonora kyrka": (59.3355, 18.0810),
    "artillerigården": (59.3340, 18.0790),
    "skeppsholmen": (59.3258, 18.0838),
    "kastellholmen": (59.3232, 18.0855),
    "djurgården": (59.3260, 18.1150),
    "kungliga djurgården": (59.3260, 18.1150),
    "djurgårdsbrunn": (59.3320, 18.1220),
    "trångsund": (59.32564, 18.06979),
}

# Old-spelling rewrites applied before gazetteer matching and OSM queries.
OLD_SPELLING_REWRITES = [
    ("kongsholm", "kungsholm"),
    ("kongsträdgård", "kungsträdgård"),
    ("jerntorget", "järntorget"),
    ("jern-torget", "järntorget"),
    ("drottningegatan", "drottninggatan"),
    ("drottingegatan", "drottninggatan"),
    ("regeringsgatun", "regeringsgatan"),
    ("kyrckan", "kyrkan"),
    ("kyrckia", "kyrka"),
    # OCR / old misreads of Kråkgränd (Skeppsbron area)
    ("kräfgränden", "kråkgränden"),
    ("kräfgränd", "kråkgränd"),
    ("kräggränden", "kråkgränden"),
    ("kräggränd", "kråkgränd"),
    ("kräkgränden", "kråkgränden"),
    ("kräkgränd", "kråkgränd"),
    # Hyphenated OCR / old forms
    ("opera-huset", "operahuset"),
    ("opera huset", "operahuset"),
    ("swenska prastgatan", "svenska prästgatan"),
    ("swenska prästgatan", "svenska prästgatan"),
]


def fold_diacritics(text: str) -> str:
    return (
        text.replace("å", "a")
        .replace("ä", "a")
        .replace("ö", "o")
        .replace("é", "e")
        .replace("ü", "u")
    )


def normalize_for_match(text: str) -> str:
    out = text.lower()
    for old, new in OLD_SPELLING_REWRITES:
        out = out.replace(old, new)
    out = fold_diacritics(out)
    out = out.replace("hwar", "var").replace("wid ", "vid ").replace("w", "v")
    return re.sub(r"\s+", " ", out).strip()


# Keys are matched with a leading word boundary (so "haga" can't hit "behagade")
# while allowing inflected suffixes ("stortorgets"). Longest keys are tried first.
_GAZETTEER_NORMALIZED: List[Tuple[re.Pattern, str, Tuple[float, float]]] = sorted(
    (
        (re.compile(r"(?<![a-z])" + re.escape(normalize_for_match(k))), k, v)
        for k, v in STOCKHOLM_GAZETTEER.items()
    ),
    key=lambda item: -len(item[0].pattern),
)

_GAMLA_STAN_GAZETTEER_STEMS = frozenset(
    normalize_for_match(k)
    for k, (lat, lng) in STOCKHOLM_GAZETTEER.items()
    if GAMLA_STAN_BBOX[0] <= lng <= GAMLA_STAN_BBOX[2] and GAMLA_STAN_BBOX[1] <= lat <= GAMLA_STAN_BBOX[3]
)


def gazetteer_lookup(*texts: Optional[str]) -> Optional[Tuple[float, float, str]]:
    """Return the best gazetteer match across texts (equal weight — prefer geocode_record)."""
    weighted: List[Tuple[int, Optional[str]]] = [(100, t) for t in texts]
    return gazetteer_lookup_weighted(*weighted)


_CONTACT_PLACE_RE = re.compile(
    r"\b(?:wid|vid|hos|på|pä|uti|i|nära)\s+(?:lilla\s+)?([a-zåäöéü0-9\-\s]{3,40})",
    re.IGNORECASE,
)


def gazetteer_lookup_weighted(*field_texts: Tuple[int, Optional[str]]) -> Optional[Tuple[float, float, str]]:
    """Pick gazetteer hit by field priority, then name specificity.

    Address and original-spelling contact lines (``wid Mynttorget``) beat incidental
    mentions in locations (e.g. rooms near Norrmalmstorg but inquire at Mynttorget).
    """
    best_score = -1
    best: Optional[Tuple[float, float, str]] = None
    for weight, text in field_texts:
        if not text:
            continue
        raw = str(text)
        haystack = normalize_for_match(raw)
        contact_bonus = 250 if weight >= 400 and _CONTACT_PLACE_RE.search(raw) else 0
        for pattern, display_key, (lat, lng) in _GAZETTEER_NORMALIZED:
            if pattern.search(haystack):
                key_len = len(normalize_for_match(display_key))
                score = weight + contact_bonus + key_len
                if score > best_score:
                    best_score = score
                    best = (lat, lng, display_key.title())
                break
    return best


def geocode_texts(*texts: Optional[str]) -> Tuple[float, float, Optional[str], str]:
    """Gazetteer-only geocoding: (lat, lng, matched_place, status)."""
    hit = gazetteer_lookup(*texts)
    if hit:
        return hit[0], hit[1], hit[2], "matched"
    lat, lng = DISTRICT_FALLBACK
    return lat, lng, None, "district_fallback"


# --- online geocoding (Nominatim/OSM, cached) ----------------------------------

GEOCODE_CACHE_PATH = SCRIPT_DIR / ".geocode_cache.json"
STOCKHOLM_VIEWBOX = (17.90, 59.40, 18.20, 59.27)  # left, top, right, bottom
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
_last_nominatim_call = 0.0
_geocode_cache: Optional[Dict[str, Optional[List[float]]]] = None

# Words that are too generic to be geocoding candidates.
GENERIC_PLACE_WORDS = {
    "staden", "stockholm", "norr", "söder", "norra", "södra", "boden", "huset",
    "gården", "torget", "gatan", "källaren", "sverige", "här i staden", "bergen",
    "riket", "landet", "kronan", "herrgård", "herrgården", "malmörne",
    "stockholms län", "stockholms stad", "stad", "byn", "kyrkan", "kyrka",
    "europa", "norden",
}


def _load_geocode_cache() -> Dict[str, Optional[List[float]]]:
    global _geocode_cache
    if _geocode_cache is None:
        try:
            _geocode_cache = json.loads(GEOCODE_CACHE_PATH.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 - missing or corrupt cache
            _geocode_cache = {}
    return _geocode_cache


def _save_geocode_cache() -> None:
    if _geocode_cache is not None:
        write_json_atomic(GEOCODE_CACHE_PATH, _geocode_cache)


def modernize_place_query(name: str) -> str:
    """Turn an old-spelling place name into a modern query string for OSM."""
    out = name.strip().strip(".,;:")
    out = re.sub(r"^(vid|wid|på|pä|uti|i|hos|nära|närri)\s+", "", out, flags=re.IGNORECASE)
    lower = out.lower()
    for old, new in OLD_SPELLING_REWRITES:
        lower = lower.replace(old, new)
    # 18th-century 'w' is modern 'v'; also common OCR/old suffix variants.
    lower = lower.replace("w", "v")
    lower = re.sub(r"gatun\b", "gatan", lower)
    lower = re.sub(r"grän(den|d)\b", "gränd", lower)
    return lower


def place_stem(name: str) -> str:
    """Placename only — strip ', Gamla stan' style suffixes before matching."""
    return modernize_place_query(name.split(",")[0].strip())


def _compact_place(text: str) -> str:
    return re.sub(r"[\s\-]+", "", normalize_for_match(text))


def osm_name_matches(place_stem_text: str, osm_name: str) -> bool:
    """True when Nominatim's feature name is the place we asked for."""
    key = normalize_for_match(place_stem_text)
    got = normalize_for_match(osm_name)
    if got == key:
        return True
    if got in {key + suffix for suffix in ("en", "et", "n", "s")}:
        return True
    compact_key = _compact_place(place_stem_text)
    compact_got = _compact_place(osm_name)
    if compact_got == compact_key:
        return True
    if len(compact_key) >= 6 and compact_key in compact_got:
        return True
    if len(compact_got) >= 6 and compact_got in compact_key:
        return True
    return False


def _in_bbox(lng: float, lat: float, bbox: Tuple[float, float, float, float]) -> bool:
    min_lng, min_lat, max_lng, max_lat = bbox
    return min_lng <= lng <= max_lng and min_lat <= lat <= max_lat


def likely_gamla_stan_place(place: str) -> bool:
    stem = place_stem(place)
    if normalize_for_match(stem) in _GAMLA_STAN_GAZETTEER_STEMS:
        return True
    return bool(
        re.search(
            r"(gränd|gatan|gatun|brinken|torget|torg|bron|plan|hamn|slott|kyrka|gränden)\b",
            stem,
            re.IGNORECASE,
        )
    )


def osm_query_variants(place: str) -> List[str]:
    stem = place_stem(place)
    if likely_gamla_stan_place(stem):
        return [f"{stem}, Gamla stan, Stockholm", f"{stem}, Stockholm, Sweden"]
    return [f"{stem}, Stockholm, Sweden"]


def geocode_place_candidates(candidates: List[str]) -> Optional[Tuple[float, float, str]]:
    """Look up place-name candidates via Nominatim, bounded to Stockholm, cached."""
    global _last_nominatim_call
    import urllib.parse
    import urllib.request

    cache = _load_geocode_cache()
    left, top, right, bottom = STOCKHOLM_VIEWBOX
    for name in candidates:
        query = modernize_place_query(name)
        stem = place_stem(name)
        if len(stem) < 3 or stem in GENERIC_PLACE_WORDS:
            continue
        if _FOREIGN_PLACES.search(stem):
            continue
        cache_key = normalize_for_match(stem)
        if cache_key in cache:
            hit = cache[cache_key]
            if hit:
                return hit[0], hit[1], stem
            continue
        nominatim_q = query if "," in query else f"{query}, Stockholm, Sweden"
        params = urllib.parse.urlencode(
            {
                "q": nominatim_q,
                "format": "jsonv2",
                "limit": 1,
                "viewbox": f"{left},{top},{right},{bottom}",
                "bounded": 1,
            }
        )
        # Nominatim usage policy: max 1 request/second, identifying User-Agent.
        wait = 1.15 - (time.time() - _last_nominatim_call)
        if wait > 0:
            time.sleep(wait)
        results: List[Dict[str, Any]] = []
        for attempt in range(3):
            try:
                req = urllib.request.Request(
                    f"{NOMINATIM_URL}?{params}",
                    headers={"User-Agent": "gamla-stan-nexus/1.0 (local history research)"},
                )
                with urllib.request.urlopen(req, timeout=15) as resp:
                    results = json.loads(resp.read().decode("utf-8"))
                _last_nominatim_call = time.time()
                break
            except Exception as exc:  # noqa: BLE001 - offline or throttled
                if "429" in str(exc) and attempt < 2:
                    time.sleep(2.5 * (attempt + 1))
                    continue
                print(f"    OSM geocoding unavailable ({exc})", flush=True)
                results = []
                break
        # Accept a result only when its OSM name really IS the queried place,
        # otherwise Nominatim's fuzzy matching invents locations ("Skåne" ->
        # Skånegatan, "Boston" -> Bostonvägen). Allow definite-form suffixes.
        if results:
            osm_name = str(results[0].get("name") or "").strip() or str(
                results[0].get("display_name") or ""
            ).split(",")[0]
            lat, lng = float(results[0]["lat"]), float(results[0]["lon"])
            if not osm_name_matches(stem, osm_name):
                results = []
            elif likely_gamla_stan_place(stem) and not _in_bbox(lng, lat, GAMLA_STAN_BBOX):
                results = []
        if results:
            lat, lng = float(results[0]["lat"]), float(results[0]["lon"])
            cache[cache_key] = [lat, lng]
            _save_geocode_cache()
            return lat, lng, stem
        cache[cache_key] = None
        _save_geocode_cache()
    return None


def geocode_matched_place(place: str) -> Optional[Tuple[float, float]]:
    """Snap a gazetteer hit to OSM street/square geometry (cached)."""
    hit = geocode_place_candidates(osm_query_variants(place))
    if hit:
        return hit[0], hit[1]
    return None


HOUSE_NUMBER_RE = re.compile(
    r"(?:N:o|N[°o]|nr\.)\s*(\d{1,4})\b",
    re.IGNORECASE,
)


def extract_house_number(*texts: Optional[str]) -> Optional[int]:
    """Pull N:o / nr. house numbers only (not 'Wårdshuset 3 Prinsar' etc.)."""
    for text in texts:
        if not text:
            continue
        m = HOUSE_NUMBER_RE.search(str(text))
        if m:
            n = int(m.group(1))
            if 1 <= n <= 999:
                return n
    return None


def extract_house_number_near_street(street: str, *texts: Optional[str]) -> Optional[int]:
    """House number only when it appears within ~50 chars of the matched street name."""
    street_norm = normalize_for_match(street)
    for text in texts:
        if not text:
            continue
        hay = normalize_for_match(str(text))
        pos = hay.find(street_norm)
        if pos < 0:
            continue
        window = hay[max(0, pos - 50) : pos + len(street_norm) + 50]
        m = HOUSE_NUMBER_RE.search(window)
        if m:
            n = int(m.group(1))
            if 1 <= n <= 999:
                return n
    return None


_CORNER_RE = re.compile(
    r"(?:hörnet|hörnhuset|hörnhus)\s+(?:af|vid)\s+(.+?)\s+och\s+(.+?)(?:[.,;]|$|\s+i\s+|\s+på\s+)",
    re.IGNORECASE,
)


def gazetteer_corner_lookup(*texts: Optional[str]) -> Optional[Tuple[float, float, str]]:
    """Corner of two streets — pin stays on the gata/brinken, not a nearby gränd."""
    for text in texts:
        if not text:
            continue
        m = _CORNER_RE.search(str(text))
        if not m:
            continue
        leg_a = modernize_place_query(m.group(1).strip())
        leg_b = modernize_place_query(m.group(2).strip())
        hit_a = gazetteer_lookup(leg_a)
        hit_b = gazetteer_lookup(leg_b)
        if not hit_a or not hit_b:
            continue
        # Weight toward the street (gatan/brinken), not alleys or mid-point drift.
        def is_street(name: str) -> bool:
            n = normalize_for_match(name)
            return any(x in n for x in ("gatan", "brinken", "bron", "torget", "plan"))

        if is_street(hit_a[2]) and not is_street(hit_b[2]):
            primary, secondary = hit_a, hit_b
        elif is_street(hit_b[2]) and not is_street(hit_a[2]):
            primary, secondary = hit_b, hit_a
        else:
            primary, secondary = hit_a, hit_b
        lat = primary[0] * 0.85 + secondary[0] * 0.15
        lng = primary[1] * 0.85 + secondary[1] * 0.15
        return lat, lng, primary[2]
    return None


def geocode_record(
    address: Optional[str],
    locations: List[str],
    *context_texts: Optional[str],
    online: bool = True,
) -> Tuple[Optional[float], Optional[float], Optional[str], str]:
    """Tiered geocoder: gazetteer -> OSM street snap -> OSM address -> off-map.

    Placement policy:
    - Pick the most specific place name across all fields (gränd beats gatan beats bron).
    - Snap matched place to OSM street/square geometry (on the actual road, not a hand-picked midpoint).
    - Street + house number (N:o only, near that street): OSM address lookup.
    - No place resolved: off the map.
    """
    all_texts = ([address] if address else []) + locations + list(context_texts)
    label = context_texts[0] if context_texts else None
    summary = context_texts[1] if len(context_texts) > 1 else None
    original = context_texts[2] if len(context_texts) > 2 else None

    corner = gazetteer_corner_lookup(original, address, summary)
    if corner:
        lat, lng, place = corner
        if online:
            osm_pt = geocode_matched_place(place)
            if osm_pt:
                return osm_pt[0], osm_pt[1], place, "geocoded_osm"
        return lat, lng, place, "matched"

    hit = gazetteer_lookup_weighted(
        (1000, address),
        (600, original),
        (200, label),
        *[(120, loc) for loc in locations],
        (80, summary),
    )

    if hit and online:
        lat, lng, place = hit
        house_no = extract_house_number_near_street(place, *all_texts)
        if house_no:
            osm_addr = geocode_place_candidates(
                [f"{place} {house_no}, Gamla stan, Stockholm", f"{place} {house_no}, Stockholm, Sweden"]
            )
            if osm_addr:
                return osm_addr[0], osm_addr[1], place, "geocoded_osm"
        osm_pt = geocode_matched_place(place)
        if osm_pt:
            return osm_pt[0], osm_pt[1], place, "geocoded_osm"
        return lat, lng, place, "matched"

    if hit:
        return hit[0], hit[1], hit[2], "matched"

    if online:
        # Only OSM-fallback on extracted locations, or addresses the gazetteer already knows.
        # Skips LLM junk like "Haga" parsed from "behagade".
        candidates = [c for c in locations if c and len(place_stem(c)) >= 5]
        if address and gazetteer_lookup(address):
            candidates.insert(0, address)
        osm = geocode_place_candidates(candidates)
        if osm:
            gaz = gazetteer_lookup(osm[2])
            place_name = gaz[2] if gaz else osm[2].title()
            return osm[0], osm[1], place_name, "geocoded_osm"

    return None, None, None, "district_fallback"


# --- date handling -----------------------------------------------------------

SWEDISH_MONTHS = {
    "jan": 1, "januari": 1, "januarii": 1,
    "feb": 2, "februari": 2, "februarii": 2,
    "mar": 3, "mars": 3, "martii": 3, "mart": 3,
    "apr": 4, "april": 4, "aprilis": 4,
    "maj": 5, "maji": 5, "may": 5,
    "jun": 6, "juni": 6, "junii": 6,
    "jul": 7, "juli": 7, "julii": 7,
    "aug": 8, "augusti": 8,
    "sep": 9, "sept": 9, "september": 9, "septembris": 9,
    "okt": 10, "oct": 10, "oktober": 10, "october": 10, "octobris": 10,
    "nov": 11, "november": 11, "novembris": 11,
    "dec": 12, "december": 12, "decembris": 12,
}

# Words meaning "the current month" in 18th-century notices (incl. OCR variants).
CURRENT_MONTH_WORDS = {"hujus", "hujud", "hujuk", "dennes", "denne", "innevarande"}

_DATE_TEXT_RE = re.compile(
    r"(?:d(?:en)?\.?\s+)?(\d{1,2})(?::de|:a)?\s+([a-zåäö]+)\.?\s*(\d{4})?",
    re.IGNORECASE,
)


def issue_date_from_filename(filename: str) -> Optional[str]:
    """KB filenames embed the issue date: bib13506739_17800124_... -> 1780-01-24."""
    m = re.search(r"_((?:1[5-9]|20)\d{2})(\d{2})(\d{2})_", filename)
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if 1 <= mo <= 12 and 1 <= d <= 31:
        return f"{y:04d}-{mo:02d}-{d:02d}"
    return None


def page_number_from_filename(filename: str) -> Optional[int]:
    m = re.search(r"_(\d{4})(?:_\d+x\d+)?\.(?:jpg|jpeg|png)$", filename, re.IGNORECASE)
    return int(m.group(1)) if m else None


def resolve_date(raw: Optional[str], issue_date: Optional[str]) -> Optional[str]:
    """Normalize a model-provided or in-text date to YYYY-MM-DD.

    Handles ISO dates, partial ISO, and old Swedish forms like
    'd. 17 Januarii 1780' / 'den 4 Dec.'. Missing years resolve against the
    issue date; unresolvable input falls back to the issue date itself.
    """
    issue_year = int(issue_date[:4]) if issue_date else None
    if raw:
        raw = raw.strip()
        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", raw)
        if m:
            return m.group(0)
        m = re.match(r"^(\d{4})-(\d{2})$", raw)
        if m:
            return f"{m.group(1)}-{m.group(2)}-01"
        m = re.match(r"^(\d{4})$", raw)
        if m:
            return f"{raw}-01-01"
        for m in _DATE_TEXT_RE.finditer(raw.lower()):
            day = int(m.group(1))
            word = m.group(2).rstrip(".")
            month = SWEDISH_MONTHS.get(word)
            if month is None and word in CURRENT_MONTH_WORDS and issue_date:
                month = int(issue_date[5:7])
            year = int(m.group(3)) if m.group(3) else issue_year
            if month and year and 1 <= day <= 31:
                resolved = f"{year:04d}-{month:02d}-{day:02d}"
                # A year-less date after the issue date must refer to last year.
                if not m.group(3) and issue_date and resolved > issue_date:
                    resolved = f"{year - 1:04d}-{month:02d}-{day:02d}"
                return resolved
    return issue_date


# --- people normalization ----------------------------------------------------

# Common 18th-century Swedish titles/professions used to split "role" out of names.
TITLE_PREFIXES = [
    "capitainen", "capitaine", "capitain", "kaptenen", "kapten",
    "majoren", "major", "generalen", "amiralen", "översten", "öfversten",
    "lieutenanten", "lieutenant", "löjtnanten", "löjtnant",
    "fändriken", "fändrik", "ryttmästaren", "ryttmästare", "kornetten",
    "rådmannen", "rådman", "borgmästaren", "häradshövdingen", "assessorn", "assessor",
    "sekreteraren", "notarien", "kammarherren", "kanslisten", "landshövdingen",
    "handelsmannen", "handelsman", "köpmannen", "köpman", "grosshandlaren",
    "bryggaren", "bagaren", "skomakaren", "skräddaren", "snickaren", "smeden",
    "guldsmeden", "bläckslagaren", "vagnmannen", "vagnman", "kyparen", "krögaren",
    "bonden", "drängen", "pigan", "jungfrun", "jungfru", "änkan", "enkan",
    "mäster", "mästaren", "gesällen", "lärlingen",
    "professorn", "professor", "doktorn", "doktor", "doctor", "magistern",
    "biskopen", "prosten", "pastorn", "kyrkoherden", "komministern", "klockaren",
    "grefven", "greven", "grefve", "friherren", "friherre", "friherrinnan",
    "baronen", "baron", "hertigen", "prinsen", "prinsessan",
    "herr", "hr", "fru", "frn", "mademoiselle", "madame", "mamsell",
]
_TITLE_PREFIXES_SORTED = sorted(TITLE_PREFIXES, key=len, reverse=True)


def split_title_from_name(name: str, role: Optional[str]) -> Tuple[str, Optional[str]]:
    """'Bläckslagaren Carl Ludvig Bauman' -> ('Carl Ludvig Bauman', 'Bläckslagaren')."""
    cleaned = re.sub(r"\s+", " ", name).strip().strip(".,;:")
    if role and role.strip():
        return cleaned, role.strip()
    lower = cleaned.lower()
    for title in _TITLE_PREFIXES_SORTED:
        if lower.startswith(title + " "):
            rest = cleaned[len(title):].strip()
            if len(rest) >= 2:
                return rest, cleaned[: len(title)]
    return cleaned, None


def clean_people(raw_people: Any) -> List[Dict[str, Optional[str]]]:
    """Validate, split roles from names, and dedupe the people list."""
    out: List[Dict[str, Optional[str]]] = []
    seen = set()
    if not isinstance(raw_people, list):
        return out
    for entry in raw_people:
        if isinstance(entry, dict):
            name = str(entry.get("name") or "").strip()
            role = entry.get("role")
            role = str(role).strip() if role else None
        elif isinstance(entry, str):
            name, role = entry.strip(), None
        else:
            continue
        # Drop junk the model tends to emit: generic words, trailing 'm. fl.'
        name = re.sub(r"\s*m\.?\s*fl\.?$", "", name).strip()
        if len(name) < 3 or name.lower() in {"utlänningen", "anonymus", "allmänheten", "n. n."}:
            continue
        name, role = split_title_from_name(name, role)
        key = normalize_for_match(name)
        if key in seen:
            continue
        seen.add(key)
        out.append({"name": name, "role": role})
    return out


# --- category fallback (mirrors src/lib/nexusCategories.ts) -------------------

def _keywords(roots: List[str]) -> re.Pattern:
    return re.compile(r"(?<![a-zåäö])(?:" + "|".join(roots) + ")", re.IGNORECASE)


_CAT_PATTERNS: List[Tuple[str, re.Pattern]] = [
    ("fire", _keywords(["brand", "eldsvåda", "vådeld", "brunnit", "nedbrunn", "drunkna", "omkom", "olycka"])),
    ("crime", _keywords(["stöld", "stulit", "stulna", "tjuf", "tjuv", "rån", "mord", "dråp", "inbrott",
                          "häkt", "arrester", "fängelse", "rättegång", "dömd", "straff", "efterlys", "bortstul"])),
    ("conspiracy", _keywords(["sammansvärjning", "konspiration", "förräderi", "uppror", "attentat"])),
    ("church", _keywords(["kyrka", "kyrkan", "präst(?!gatan)", "församling", "begravning", "begrafning",
                           "döpt", "vigsel", "predik", "gudstjänst", "dödsfall", "afliden", "avliden"])),
    ("court", _keywords(["kongl", "kungl", "konung", "hovet", "hofvet", "majestät", "riksdag",
                          "hertig", "prins", "drottning", "förordning", "kungörelse"])),
    ("commerce", _keywords(["auktion", "auction", "til salu", "till salu", "försälj", "utbjud", "handel",
                             "skepp", "fartyg", "inkommit", "ankommit", "priser", "uthyr", "prenumeration"])),
]

_FOREIGN_PLACES = _keywords([
    "paris", "london", "madrid", "wien", "konstantinopel", "petersburg", "berlin",
    "köpenhamn", "kiöpenhamn", "amsterdam", "neapel", "lissabon", "hamburg", "egypten",
    "warschau", "bryssel", "genua", "venedig", "cadiz", "gibraltar", "algier",
    "amerika", "america", "boston", "philadelphia", "florida", "frankrike", "england",
    "spanien", "portugal", "holland", "ryssland", "turkiet", "italien", "preussen",
    "polen", "danmark",
])


def fallback_category(model_category: Optional[str], *texts: Optional[str]) -> str:
    if model_category in CATEGORIES:
        return model_category
    joined = " ".join(t for t in texts if t)
    if _FOREIGN_PLACES.search(joined) and not geocode_texts(joined)[3] == "matched":
        return "foreign"
    for cat, pattern in _CAT_PATTERNS:
        if pattern.search(joined):
            return cat
    return "daily"


# --- image tiling ------------------------------------------------------------

TARGET_COLUMN_WIDTH = 1200   # px; upscale narrower columns so Fraktur stays legible
BAND_ASPECT = 1.15           # band height ≈ width * aspect
BAND_OVERLAP = 0.10          # vertical overlap between bands, for seam stitching


def detect_column_gutter(im: Image.Image) -> Optional[int]:
    """Find the bright vertical gutter between two text columns, if any."""
    gray = im if im.mode == "L" else im.convert("L")
    # Averaging every column to one pixel row gives a cheap brightness profile.
    profile = list(gray.resize((gray.width, 1), Image.BOX).tobytes())
    lo, hi = int(gray.width * 0.35), int(gray.width * 0.65)
    window = max(3, gray.width // 120)
    best_x, best_val = None, -1.0
    for x in range(lo, hi - window):
        val = sum(profile[x : x + window]) / window
        if val > best_val:
            best_val, best_x = val, x + window // 2
    page_mean = sum(profile) / len(profile)
    if best_x is not None and best_val > page_mean * 1.06:
        return best_x
    return None


def prepare_tiles(img_path: Path, tiling: bool = True) -> List[Tuple[str, bytes]]:
    """Split a page scan into contrast-boosted, column-aware JPEG tiles.

    Returns [(tile_label, jpeg_bytes)] in reading order: left column top-to-bottom,
    then right column. Without tiling, returns the whole (enhanced) page.
    """
    im = Image.open(img_path).convert("L")
    im = ImageOps.autocontrast(im, cutoff=1)

    def to_jpeg(img: Image.Image) -> bytes:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)
        return buf.getvalue()

    if not tiling:
        return [("page", to_jpeg(im))]

    gutter = detect_column_gutter(im)
    if gutter:
        pad = int(im.width * 0.012)  # small overlap so the gutter cut can't clip glyphs
        columns = [
            ("L", im.crop((0, 0, min(gutter + pad, im.width), im.height))),
            ("R", im.crop((max(gutter - pad, 0), 0, im.width, im.height))),
        ]
    else:
        columns = [("C", im)]

    tiles: List[Tuple[str, bytes]] = []
    for col_label, col in columns:
        if col.width < TARGET_COLUMN_WIDTH:
            scale = TARGET_COLUMN_WIDTH / col.width
            col = col.resize((TARGET_COLUMN_WIDTH, int(col.height * scale)), Image.LANCZOS)
        band_h = int(col.width * BAND_ASPECT)

        # One band if the column is barely taller than a band; otherwise evenly
        # spaced bands covering the full height with modest, uniform overlap.
        if col.height <= band_h * 1.35:
            tops = [0]
            band_h = col.height
        else:
            n = math.ceil((col.height - band_h * BAND_OVERLAP) / (band_h * (1 - BAND_OVERLAP)))
            tops = [round(i * (col.height - band_h) / (n - 1)) for i in range(n)]

        for band_idx, top in enumerate(tops):
            band = col.crop((0, top, col.width, min(top + band_h, col.height)))
            tiles.append((f"{col_label}{band_idx + 1}", to_jpeg(band)))
    return tiles


def merge_band_texts(band_texts: List[str]) -> str:
    """Stitch overlapping band transcriptions, dropping duplicated seam lines."""
    merged: List[str] = []
    for text in band_texts:
        lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
        if not merged:
            merged.extend(lines)
            continue
        drop = 0
        max_k = min(15, len(merged), len(lines))
        for k in range(max_k, 0, -1):
            tail = merged[-k:]
            head = lines[:k]
            score = sum(
                difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio()
                for a, b in zip(tail, head)
            ) / k
            if score > 0.72:
                drop = k
                break
        merged.extend(lines[drop:])
    return "\n".join(merged)


# --- prompts & schemas ---------------------------------------------------------

OCR_PROMPT = (
    "You are a high-precision HTR engine for 18th-century Swedish newspapers printed "
    "in Fraktur (blackletter). Transcribe this newspaper section EXACTLY as printed.\n"
    "Rules:\n"
    "1. VERBATIM: keep the original 18th-century spelling. Never modernize, never translate.\n"
    "2. FRAKTUR PITFALLS: long s (ſ) vs f; 'w' is common (hwar, swar); 'B' vs 'V' "
    "(Betjent, Boklåda); 'K' vs 'R' (Kungörelse). Keep abbreviations: N:o, Kgl., d., H:r.\n"
    "3. LAYOUT: this image is a single column section. Read top to bottom. Preserve "
    "line breaks. Keep end-of-line hyphenation as printed.\n"
    "4. If part of the image is an adjacent column edge or margin noise, ignore it.\n"
    "5. Output ONLY the transcribed text. No commentary, no headings, no markdown."
)

SEGMENT_PROMPT = """You segment 18th-century Swedish newspaper text into its individual notices.

The text below is one page of a Swedish newspaper from the 1780s. Split it into separate
notices/announcements/articles — NOT into individual lines or verses.

Rules:
- Copy the text of each notice VERBATIM from the input. Do not rewrite, summarize or translate.
- Every line of the input must belong to exactly one notice. Do not drop text.
- A long article, essay, letter, or poem is ONE notice even if it spans many lines.
- A numbered court list (1) Emellan..., 2) Emellan...) plus its heading is ONE notice.
- Arriving-traveller lists and exchange-rate tables (Coursen) are ONE notice each.
- Do NOT create a separate notice for each line of poetry or each numbered court case.

PAGE TEXT:
"""

SEGMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "notices": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
        }
    },
    "required": ["notices"],
}

EXTRACT_PROMPT_TEMPLATE = """You extract structured data from ONE notice in an 18th-century Swedish newspaper
(issue date: {issue_date}). Analyze the notice and fill the JSON fields:

- label: short Swedish title for this notice (e.g. "Auktion: Möbler vid Stortorget").
- category: exactly one of
    crime      (theft, assault, trials, wanted notices, punishments)
    fire       (fires, drownings, accidents)
    court      (royalty, government, official proclamations, military)
    conspiracy (plots, treason, riots)
    church     (sermons, clergy, deaths, funerals, baptisms, weddings)
    commerce   (auctions, sales, rentals, ships, prices, subscriptions)
    foreign    (news datelined from abroad: Paris, London, Wien...)
    daily      (everything else: lost & found, travellers, employment, social life)
- date_mentioned: a date stated IN the text (e.g. "d. 17 Januarii 1780", "den 16 hujus"),
  copied verbatim, else null.
- address: the most specific street/square/building in Stockholm mentioned, else null.
- summary: one short sentence in modern Swedish for internal categorization/geocoding only
  (NOT a user-facing summary — the display text is produced in a separate cleanup step).
  ALWAYS write in Swedish, never in English.
- people: every named person, with their title/profession as role when stated.
  Do not invent people. Empty array if none are named.
- locations: every street, square, building or town mentioned, original spelling.
- crime: short description of the crime if category is crime, else null.
- fire_cause: cause of fire/accident if applicable, else null.
- parish_event: type of church event (begravning, vigsel, dop...) if applicable, else null.

NOTICE TEXT:
{notice_text}
"""

MODERNIZE_PROMPT_TEMPLATE = """Modernisera denna svenska tidningstext från 1700-talet till modern svenska.
Behåll samma innehåll och ungefär samma längd. Uppdatera stavning och grammatik och rätta OCR-fel.
Skriv inte en sammanfattning.

{original}"""

MODERNIZE_RETRY_SUFFIX = """

Skriv om hela texten ovan i modern svenska. Svaret måste vara ungefär lika långt som originalet."""

MODERNIZE_SCHEMA = {
    "type": "object",
    "properties": {
        "modernized_text": {"type": "string"},
    },
    "required": ["modernized_text"],
}

# Legacy alias kept for tests/imports
CLEAN_PROMPT_TEMPLATE = MODERNIZE_PROMPT_TEMPLATE
CLEAN_SCHEMA = MODERNIZE_SCHEMA

EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "label": {"type": "string"},
        "category": {"type": "string", "enum": CATEGORIES},
        "date_mentioned": {"type": ["string", "null"]},
        "address": {"type": ["string", "null"]},
        "summary": {"type": "string"},
        "people": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "role": {"type": ["string", "null"]},
                },
                "required": ["name"],
            },
        },
        "locations": {"type": "array", "items": {"type": "string"}},
        "crime": {"type": ["string", "null"]},
        "fire_cause": {"type": ["string", "null"]},
        "parish_event": {"type": ["string", "null"]},
    },
    "required": ["label", "category", "summary", "people", "locations"],
}


# --- model calls ---------------------------------------------------------------

def chat_with_retry(
    model: str,
    prompt: str,
    ctx: int,
    images: Optional[List[bytes]] = None,
    schema: Optional[Dict[str, Any]] = None,
    retries: int = 2,
) -> str:
    message: Dict[str, Any] = {"role": "user", "content": prompt}
    if images:
        message["images"] = images
    last_err: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            response = chat(
                model=model,
                messages=[message],
                format=schema,
                options={"num_ctx": ctx, "temperature": 0},
            )
            return response["message"]["content"]
        except TypeError as exc:
            # Old ollama client without the `format` parameter.
            raise SystemExit(
                "Your ollama python client is too old for structured outputs. "
                "Run: pip install -U ollama (needs >= 0.4)"
            ) from exc
        except Exception as exc:  # noqa: BLE001 - local server hiccups, OOM, timeouts
            last_err = exc
            if attempt < retries:
                wait = 3 * (attempt + 1)
                print(f"    retry in {wait}s ({exc})", flush=True)
                time.sleep(wait)
    raise RuntimeError(f"Model call failed after {retries + 1} attempts: {last_err}")


CONTINUATION_LINE_RE = re.compile(r"^\(Slutet härav", re.IGNORECASE)
NUMBERED_CASE_RE = re.compile(r"^\d+\)\s+Emellan\b", re.IGNORECASE)
COURT_HEADER_RE = re.compile(r"(Dommar|Jusitika-Revision|Mädige Dommar)", re.IGNORECASE)
NEW_ARTICLE_RE = re.compile(
    r"^(Kongl\.|Ankomne|Tjenst|Auktion|Förlorat|Borttappad|Den \d{1,2} )",
    re.IGNORECASE,
)
EXCHANGE_RATE_RE = re.compile(r"^(På |=\s*=|Coursen)", re.IGNORECASE)
PROMPT_LEAKAGE_RE = re.compile(
    r"(skriv aldrig|förbjudet|originaltext|moderniserar en svensk|för ankomst|ocr-transkrib|"
    r"meta-text|sammanfattning|historical newspaper notice)",
    re.IGNORECASE,
)
JUNK_LABELS = frozenset(
    {
        "forbudet",
        "originaltext",
        "original text",
        "frakt",
        "original",
        "uppgift",
        "regler",
    }
)


def _last_line(text: str) -> str:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    return lines[-1] if lines else text.strip()


def looks_like_section_title(line: str) -> bool:
    line = line.strip()
    if NUMBERED_CASE_RE.match(line):
        return False
    if NEW_ARTICLE_RE.match(line) or COURT_HEADER_RE.search(line):
        return True
    if len(line) < 60 and line.endswith(".") and "," not in line and " och " not in line.lower():
        return True
    return False


def should_merge_notices(previous: str, current: str) -> bool:
    prev = previous.strip()
    curr = current.strip()
    if not prev or not curr:
        return False
    if len(prev) > 500 and looks_like_section_title(curr.split("\n")[0]):
        return False
    if CONTINUATION_LINE_RE.match(curr) and len(curr) < 100:
        return True
    if NUMBERED_CASE_RE.match(curr) and (
        COURT_HEADER_RE.search(prev) or NUMBERED_CASE_RE.match(_last_line(prev))
    ):
        return True
    if EXCHANGE_RATE_RE.search(curr) and (
        "Coursen" in prev or EXCHANGE_RATE_RE.search(_last_line(prev))
    ):
        return True
    if NEW_ARTICLE_RE.match(curr) and not NUMBERED_CASE_RE.match(curr):
        return False
    if len(curr) < 120 and len(_last_line(prev)) < 120 and not COURT_HEADER_RE.search(curr):
        return True
    if len(prev) < 50 and prev.endswith((".", ":", ".)")) and len(curr) < 200:
        return True
    return False


def refine_notices(notices: List[str]) -> List[str]:
    """Merge over-segmented lines (poetry verses, court lists, exchange rates)."""
    merged: List[str] = []
    for notice in notices:
        text = notice.strip()
        if not text:
            continue
        if merged and should_merge_notices(merged[-1], text):
            merged[-1] = merged[-1] + "\n" + text
        else:
            merged.append(text)
    return [n for n in merged if len(n.strip()) >= 35 or COURT_HEADER_RE.search(n)]


def derive_label(extracted_label: str, notice_text: str, index: int) -> str:
    label = extracted_label.strip().strip('"')
    normalized = fold_diacritics(label.lower()).strip()
    if normalized in JUNK_LABELS or len(label) < 12:
        for line in notice_text.splitlines():
            line = line.strip()
            if len(line) >= 15:
                return line[:80]
        return f"Notis {index + 1}"
    return label[:80]


def naive_segment(raw_text: str) -> List[str]:
    """Fallback segmentation: split on blank lines / long dashes, merge tiny chunks."""
    blocks = [b.strip() for b in re.split(r"\n\s*\n|\n(?=—)", raw_text) if b.strip()]
    if len(blocks) <= 1:
        lines = [ln.strip() for ln in raw_text.splitlines() if ln.strip()]
        long_lines = sum(1 for ln in lines if len(ln) > 150)
        if len(lines) > 3 and long_lines >= len(lines) * 0.4:
            blocks = lines
    notices: List[str] = []
    for block in blocks:
        # Section headers like "Tjenstsökande:" belong to the following notice.
        if notices and len(notices[-1]) < 60 and notices[-1].endswith(":"):
            notices[-1] += "\n" + block
            continue
        if notices and len(block) < 80:
            notices[-1] += "\n" + block
        else:
            notices.append(block)
    return refine_notices(notices)


# --- record assembly -----------------------------------------------------------

def slugify(text: str) -> str:
    out = fold_diacritics(text.lower())
    out = re.sub(r"[^a-z0-9]+", "-", out).strip("-")
    return out[:60] or "notis"


GENERIC_DESCRIPTION_RE = re.compile(
    r"^(denna notis|notisen|notis om|i notisen|texten handlar|här listas|listan innehåller|"
    r"annonserar|meddelar att|upplyser om)",
    re.IGNORECASE,
)


def is_generic_description(record: Dict[str, Any]) -> bool:
    meta = record.get("metadata") or {}
    original = str(meta.get("original_spelling") or "").strip()
    description = str(record.get("description") or "").strip()
    if not original or not description:
        return bool(original) and not description
    if GENERIC_DESCRIPTION_RE.match(description):
        return True
    return len(description) < len(original) * 0.45


def modernized_text_acceptable(original: str, modernized: str) -> bool:
    modernized = modernized.strip()
    if not modernized:
        return False
    if GENERIC_DESCRIPTION_RE.match(modernized):
        return False
    if PROMPT_LEAKAGE_RE.search(modernized):
        return False
    return len(modernized) >= len(original) * 0.45


def build_record(
    extracted: Dict[str, Any],
    notice_text: str,
    file_name: str,
    stem: str,
    index: int,
    issue_date: Optional[str],
    model_name: str,
    online_geocode: bool = True,
) -> Dict[str, Any]:
    label = derive_label(str(extracted.get("label") or ""), notice_text, index)
    summary = str(extracted.get("summary") or "").strip()
    address = extracted.get("address")
    address = str(address).strip() if address else None
    locations = [
        str(loc).strip()
        for loc in (extracted.get("locations") or [])
        if isinstance(loc, str) and str(loc).strip()
    ]
    people = clean_people(extracted.get("people"))

    category = fallback_category(extracted.get("category"), label, summary, notice_text)
    date_mentioned = extracted.get("date_mentioned")
    if not date_mentioned:
        # The event date is usually stated in the opening line of the notice.
        date_mentioned = notice_text[:160]
    date = resolve_date(date_mentioned, issue_date)

    record_id = f"{stem}:{index + 1}:{slugify(label)}"
    lat, lng, matched_place, geocode_status = geocode_record(
        address,
        locations,
        label,
        summary,
        notice_text,
        online=online_geocode,
    )

    def opt(key: str) -> Optional[str]:
        val = extracted.get(key)
        return str(val).strip() if val and str(val).strip().lower() not in {"null", "none", "n/a"} else None

    paper = next(
        (title for bib, title in BIB_TO_PAPER.items() if file_name.startswith(bib)),
        "Okänd tidning",
    )

    return {
        "id": record_id,
        "label": label,
        "date": date,
        "address": address or matched_place,
        "description": "",
        "resident": people[0]["name"] if people else None,
        "lat": lat,
        "lng": lng,
        "metadata": {
            "source_paper": paper,
            "issue_date": issue_date,
            "page": page_number_from_filename(file_name),
            "archive_ref": file_name,
            "original_spelling": notice_text.strip(),
            "category": category,
            "themes": [CATEGORY_LABELS[category]],
            "record_type": "Newspaper Notice",
            "people": people,
            "locations": locations,
            "crime": opt("crime"),
            "fire_cause": opt("fire_cause"),
            "parish_event": opt("parish_event"),
            "matched_place": matched_place,
            "geocode_status": geocode_status,
            "location_approximate": geocode_status == "district_fallback",
            "ocr_model": model_name,
        },
    }


# --- pipeline ------------------------------------------------------------------

def ocr_page(img_path: Path, model: str, ctx: int, tiling: bool) -> str:
    tiles = prepare_tiles(img_path, tiling=tiling)
    print(f"  OCR: {len(tiles)} tile(s)", flush=True)
    by_column: Dict[str, List[str]] = {}
    for label, jpeg in tiles:
        t0 = time.time()
        text = chat_with_retry(model, OCR_PROMPT, ctx, images=[jpeg])
        col = label[0]
        by_column.setdefault(col, []).append(text)
        print(f"    tile {label}: {len(text)} chars in {time.time() - t0:.0f}s", flush=True)
    column_texts = [merge_band_texts(bands) for _, bands in sorted(by_column.items())]
    return "\n\n".join(column_texts)


def segment_page(raw_text: str, model: str, ctx: int) -> List[str]:
    try:
        response = chat_with_retry(model, SEGMENT_PROMPT + raw_text, ctx, schema=SEGMENT_SCHEMA)
        payload = json.loads(response)
        notices = [
            str(n.get("text") or "").strip()
            for n in payload.get("notices", [])
            if isinstance(n, dict) and str(n.get("text") or "").strip()
        ]
        # Sanity check: the model must not have dropped most of the page.
        if notices and sum(len(n) for n in notices) >= 0.5 * len(raw_text.strip()):
            refined = refine_notices(notices)
            if len(refined) != len(notices):
                print(
                    f"    merged over-segmentation: {len(notices)} -> {len(refined)} notice(s)",
                    flush=True,
                )
            return refined
        print("    segmentation lost too much text, using naive splitter", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"    segmentation failed ({exc}), using naive splitter", flush=True)
    return naive_segment(raw_text)


def modernize_record_text(record: Dict[str, Any], model: str, ctx: int) -> Dict[str, Any]:
    """Rewrite original_spelling into modern Swedish for the description field."""
    meta = record.get("metadata") or {}
    original = str(meta.get("original_spelling") or "").strip()
    if not original:
        return record

    base_prompt = MODERNIZE_PROMPT_TEMPLATE.format(original=original[:6000])
    description = ""
    for attempt in range(2):
        prompt = base_prompt if attempt == 0 else base_prompt + MODERNIZE_RETRY_SUFFIX
        try:
            response = chat_with_retry(
                model, prompt, ctx, schema=MODERNIZE_SCHEMA, retries=1
            )
            parsed = json.loads(response)
            description = str(
                parsed.get("modernized_text") or parsed.get("description") or ""
            ).strip()
            if modernized_text_acceptable(original, description):
                break
            if attempt == 0:
                print("    modernize: output too short/generic, retrying", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"    modernize failed: {exc}", flush=True)
            break

    if not isinstance(record.get("metadata"), dict):
        record["metadata"] = {}
    if description and modernized_text_acceptable(original, description):
        record["description"] = description
        record["metadata"]["display_cleaned"] = True
        record["metadata"]["description_modernized"] = True
    else:
        record["metadata"]["modernize_failed"] = True
        print("    modernize: keeping empty description (run rewrite_descriptions.py)", flush=True)
    return record


def clean_record_text(record: Dict[str, Any], model: str, ctx: int) -> Dict[str, Any]:
    """Alias for modernize_record_text."""
    return modernize_record_text(record, model, ctx)


def extract_notice(
    notice_text: str, issue_date: Optional[str], model: str, ctx: int
) -> Optional[Dict[str, Any]]:
    prompt = EXTRACT_PROMPT_TEMPLATE.format(
        issue_date=issue_date or "okänt", notice_text=notice_text[:6000]
    )
    try:
        response = chat_with_retry(model, prompt, ctx, schema=EXTRACT_SCHEMA)
        return json.loads(response)
    except Exception as exc:  # noqa: BLE001
        print(f"    notice extraction failed: {exc}", flush=True)
        return None


def write_json_atomic(path: Path, data: Any) -> None:
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(path)


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


def rebuild_combined(json_dir: Path) -> int:
    """Merge all per-page JSON files into all_records.json for search indexing."""
    combined: List[Dict[str, Any]] = []
    for page_file in sorted(json_dir.glob("*.json")):
        if page_file.name == "all_records.json":
            continue
        try:
            records = json.loads(page_file.read_text(encoding="utf-8"))
            if isinstance(records, list):
                combined.extend(records)
        except Exception:  # noqa: BLE001 - skip corrupt files
            continue
    write_json_atomic(json_dir / "all_records.json", combined)
    return len(combined)


def process_page(
    img_path: Path, args: argparse.Namespace, text_dir: Path, json_dir: Path
) -> int:
    file_name = img_path.name
    stem = img_path.stem
    issue_date = issue_date_from_filename(file_name)
    text_path = text_dir / f"{stem}.txt"
    out_path = page_json_path(json_dir, stem)

    # Resume: reuse a saved transcription so a crash never repeats vision calls.
    if text_path.exists() and not args.force:
        raw_text = text_path.read_text(encoding="utf-8")
        print(f"  OCR: reusing {text_path.name}", flush=True)
    else:
        raw_text = ocr_page(img_path, args.model, args.ctx, tiling=not args.no_tiling)
        text_path.write_text(raw_text, encoding="utf-8")

    if len(raw_text.strip()) < 40:
        print("  page transcription is nearly empty, skipping extraction", flush=True)
        return 0

    notices = segment_page(raw_text, args.model, args.ctx)
    print(f"  Segmented into {len(notices)} notice(s)", flush=True)

    records: List[Dict[str, Any]] = []
    start_index = 0
    if out_path.exists() and page_partial_marker(json_dir, stem).exists() and not args.force:
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8"))
            if isinstance(existing, list) and existing:
                records = existing
                start_index = len(records)
                print(f"  Resuming from notice {start_index + 1}/{len(notices)}", flush=True)
        except (json.JSONDecodeError, OSError):
            records = []
            start_index = 0

    if start_index == 0:
        mark_page_started(json_dir, stem)

    for i, notice_text in enumerate(notices[start_index:], start=start_index):
        if stop_requested():
            write_json_atomic(out_path, records)
            print(
                f"  Saved {len(records)} notice(s) for {stem}; re-run to continue this page.",
                flush=True,
            )
            return len(records)

        extracted = extract_notice(notice_text, issue_date, args.model, args.ctx)
        if extracted is None:
            continue
        record = build_record(
            extracted, notice_text, file_name, stem, i, issue_date, args.model,
            online_geocode=not args.no_osm,
        )
        if not args.no_clean:
            record = modernize_record_text(record, args.model, args.ctx)
        records.append(record)
        write_json_atomic(out_path, records)
        meta = record["metadata"]
        place = meta["matched_place"] or "~district"
        print(
            f"    [{i + 1}/{len(notices)}] {meta['category']:<10} @{place:<20} {record['label'][:55]}",
            flush=True,
        )

    write_json_atomic(out_path, records)
    mark_page_complete(json_dir, stem)
    return len(records)


def refresh_existing(json_dir: Path, args: argparse.Namespace) -> int:
    """Re-run geocoding and display-text cleaning on already-extracted records.

    Works from the per-page JSON files only, so no OCR/vision calls are repeated.
    """
    page_files = [p for p in sorted(json_dir.glob("*.json")) if p.name != "all_records.json"]
    updated = 0
    for page_file in page_files:
        try:
            records = json.loads(page_file.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            print(f"  skipping {page_file.name}: {exc}")
            continue
        if not isinstance(records, list):
            continue
        changed = False
        for record in records:
            meta = record.get("metadata") or {}
            lat, lng, matched_place, status = geocode_record(
                record.get("address"),
                [loc for loc in meta.get("locations", []) if isinstance(loc, str)],
                record.get("label"),
                record.get("description"),
                meta.get("original_spelling"),
                online=not args.no_osm,
            )
            if (record.get("lat"), record.get("lng")) != (lat, lng) or meta.get("geocode_status") != status:
                changed = True
            record["lat"], record["lng"] = lat, lng
            meta["matched_place"] = matched_place
            meta["geocode_status"] = status
            meta["location_approximate"] = status == "district_fallback"

            if not args.no_clean and (
                args.reclean
                or not meta.get("description_modernized")
                or is_generic_description(record)
            ):
                modernize_record_text(record, args.model, args.ctx)
                changed = True
            record["metadata"] = meta
            updated += 1
            place = matched_place or "~district"
            print(f"  {status:<17} @{place:<22} {str(record.get('label'))[:55]}", flush=True)
        if changed:
            write_json_atomic(page_file, records)
    combined = rebuild_combined(json_dir)
    print(f"Refreshed {updated} record(s); all_records.json holds {combined}.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Local OCR + structured extraction (Ollama)")
    parser.add_argument("--input", default=str(DEFAULT_IMAGE_DIR), help="Directory with page scans")
    parser.add_argument("--output", default=str(DEFAULT_JSON_DIR), help="Directory for JSON output")
    parser.add_argument("--text-output", default=str(DEFAULT_TEXT_DIR), help="Directory for raw OCR text")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Ollama model (default: {DEFAULT_MODEL})")
    parser.add_argument("--ctx", type=int, default=DEFAULT_CTX, help="Context window (default: 8192)")
    parser.add_argument("--limit", type=int, default=0, help="Process at most N pages (0 = all)")
    parser.add_argument("--force", action="store_true", help="Reprocess pages even if output exists")
    parser.add_argument("--no-tiling", action="store_true", help="One vision call per page (faster, worse OCR)")
    parser.add_argument("--no-clean", action="store_true", help="Skip modern-Swedish rewrite from original_spelling")
    parser.add_argument("--no-osm", action="store_true", help="Skip online (Nominatim) geocoding fallback")
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Re-run geocoding + text cleaning on existing JSON output (no OCR)",
    )
    parser.add_argument(
        "--reclean",
        action="store_true",
        help="With --refresh: redo text cleaning even for already-cleaned records",
    )
    parser.add_argument(
        "--no-archive",
        action="store_true",
        help="Leave processed page scans in the input folder (default: move to input/done/)",
    )
    args = parser.parse_args()

    if chat is None and not (args.refresh and args.no_clean):
        print("The 'ollama' package is required: pip install -U ollama")
        return 1

    image_dir = Path(args.input)
    json_dir = Path(args.output)
    text_dir = Path(args.text_output)
    done_dir = image_dir / DEFAULT_DONE_DIR_NAME

    if args.refresh:
        return refresh_existing(json_dir, args)

    install_stop_handler()
    json_dir.mkdir(parents=True, exist_ok=True)
    text_dir.mkdir(parents=True, exist_ok=True)

    images = sorted(
        p
        for ext in ("*.jpg", "*.jpeg", "*.png", "*.JPG", "*.JPEG", "*.PNG")
        for p in image_dir.glob(ext)
        if p.parent.resolve() != done_dir.resolve()
    )
    if not images:
        print(f"No images found in '{image_dir}'.")
        return 0
    if args.limit > 0:
        images = images[: args.limit]

    print(f"Gamla Stan Nexus local pipeline: {len(images)} page(s), model {args.model}")
    print("=" * 60)

    total_records = 0
    archived = 0
    pages_done = 0
    for idx, img_path in enumerate(images, start=1):
        if stop_requested():
            break
        stem = img_path.stem
        if page_is_complete(json_dir, stem) and not args.force:
            print(f"[{idx}/{len(images)}] {img_path.name} — done already, skipping")
            if not args.no_archive:
                dest = archive_processed_image(img_path, done_dir)
                if dest:
                    archived += 1
                    print(f"  archived -> {dest.relative_to(image_dir)}", flush=True)
            continue
        print(f"[{idx}/{len(images)}] {img_path.name}")
        t0 = time.time()
        try:
            n = process_page(img_path, args, text_dir, json_dir)
            total_records += n
            combined = rebuild_combined(json_dir)
            pages_done += 1
            print(f"  {n} record(s) in {time.time() - t0:.0f}s; all_records.json now {combined}", flush=True)
            if stop_requested():
                print("  Stopped before archiving this page.", flush=True)
                break
            if not args.no_archive and n > 0 and page_is_complete(json_dir, stem):
                dest = archive_processed_image(img_path, done_dir)
                if dest:
                    archived += 1
                    print(f"  archived -> {dest.relative_to(image_dir)}", flush=True)
        except Exception as exc:  # noqa: BLE001 - keep the batch going
            print(f"  PAGE FAILED: {exc}")

    combined = rebuild_combined(json_dir)
    print("=" * 60)
    if stop_requested():
        print(f"Stopped early. {pages_done} page(s) finished this run; checkpoints saved.")
    print(
        f"Done. {total_records} new record(s) this run; "
        f"{archived} image(s) archived to {done_dir}; "
        f"all_records.json holds {combined}."
    )
    print(f"Raw transcriptions in {text_dir} (full-text search corpus).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
