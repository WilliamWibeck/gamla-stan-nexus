#!/usr/bin/env python3
"""Fetch digitized Swedish newspaper pages from Kungliga biblioteket (data.kb.se).

KB exposes its open, out-of-copyright newspaper scans (the same material as
tidningar.kb.se) through a JSON search API plus a IIIF Image API. This script
searches for issues of a newspaper within a span of years and downloads the
page scans straight into data_sources/images/, ready for the extraction
pipeline.

Examples:
  # List matching issues without downloading anything
  python tools/fetch_kb_newspapers.py --query "Inrikes tidningar" --from-year 1790 --to-year 1792 --list

  # Download up to 5 issues (all their pages) from 1790-1792
  python tools/fetch_kb_newspapers.py --query "Inrikes tidningar" --from-year 1790 --to-year 1792 --max-issues 5

  # Download everything from a single year, then run the pipeline
  python tools/fetch_kb_newspapers.py -q "Dagligt Allehanda" --from-year 1788 --to-year 1788 --max-issues 200
  python tools/run_pipeline.py

Notes:
  - Only material older than ~150 years is openly available via data.kb.se;
    newer pages are copyright-restricted and will not appear in results.
  - Files are named {bibId}_{yyyymmdd}_{edition}_{page}.jpg (KB's own naming),
    and already-downloaded pages are skipped, so re-runs are cheap.
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

try:
    import requests
except ModuleNotFoundError:
    print("Error: The 'requests' library is required. Install with: pip install requests")
    sys.exit(1)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_IMAGES_DIR = PROJECT_ROOT / "data_sources" / "images"

SEARCH_API = "https://data.kb.se/search"
USER_AGENT = "GamlaStanNexus/1.0 (historical research pipeline; local use)"
SEARCH_PAGE_SIZE = 50

session = requests.Session()
session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})


def search_issues(
    query: str,
    from_date: str,
    to_date: str,
    title_filter: Optional[str],
) -> Iterator[Dict[str, Any]]:
    """Yield newspaper issue packages matching the query within the date span."""
    offset = 0
    seen: set[str] = set()
    while True:
        params = {
            "q": f'"{query}"',
            "searchGranularity": "package",
            "from": from_date,
            "to": to_date,
            "limit": SEARCH_PAGE_SIZE,
            "offset": offset,
        }
        resp = session.get(SEARCH_API, params=params, timeout=30)
        resp.raise_for_status()
        payload = resp.json()
        hits = payload.get("hits", [])
        if not hits:
            return

        for hit in hits:
            package_id = hit.get("@id")
            if not package_id or package_id in seen:
                continue
            seen.add(package_id)

            genres = [
                (g.get("prefLabel") or {}).get("sv", "")
                for g in hit.get("genreForm") or []
            ]
            if genres and not any("tidning" in g.lower() for g in genres):
                continue
            if hit.get("accessAllowed") is False:
                continue

            if title_filter:
                is_part_of = hit.get("isPartOf") or {}
                series_title = (is_part_of.get("title") or "").strip().lower()
                own_title = (hit.get("title") or "").strip().lower()
                needle = title_filter.strip().lower()
                if needle not in series_title and needle not in own_title:
                    continue

            yield hit

        offset += len(hits)
        if offset >= payload.get("total", 0):
            return


def iiif_page_url(image_service_id: str, page: int, width: int) -> Optional[str]:
    """Rewrite a package's imageServiceId (which points at one page) to another page."""
    base = re.sub(r"_(\d{4})\.jp2$", f"_{page:04d}.jp2", image_service_id)
    if base == image_service_id and f"_{page:04d}.jp2" not in image_service_id:
        return None
    return f"{base}/full/{width},/0/default.jpg"


def page_identifier(hit: Dict[str, Any]) -> Optional[str]:
    """KB's package identifier, e.g. bib11653806_17601126_145120_1."""
    for ident in hit.get("identifiedBy") or []:
        value = ident.get("value") or ""
        if re.match(r"^bib\d+_\d{8}_", value):
            return value
    # Fall back to deriving it from the IIIF path.
    service = hit.get("imageServiceId") or ""
    match = re.search(r"%2F(bib\d+_\d{8}_[^_]+_\d+)_\d{4}\.jp2$", service)
    return match.group(1) if match else None


def download_issue(
    hit: Dict[str, Any],
    output_dir: Path,
    width: int,
    max_pages: int,
    delay: float,
) -> int:
    """Download all pages of one issue via IIIF. Returns number of pages saved."""
    title = hit.get("title") or "unknown issue"
    service = hit.get("imageServiceId")
    identifier = page_identifier(hit)
    if not service or not identifier:
        print(f"  Skipping '{title}': no IIIF image service in the API response.")
        return 0

    saved = 0
    for page in range(1, max_pages + 1):
        url = iiif_page_url(service, page, width)
        if not url:
            print(f"  Skipping '{title}': unrecognized IIIF path format.")
            return saved

        target = output_dir / f"{identifier}_{page:04d}.jpg"
        if target.exists():
            print(f"  Page {page} already downloaded: {target.name}")
            saved += 1
            continue

        resp = session.get(url, timeout=60)
        if resp.status_code == 404:
            break  # past the last page of this issue
        if resp.status_code != 200:
            print(f"  Page {page} failed (HTTP {resp.status_code}), stopping this issue.")
            break

        target.write_bytes(resp.content)
        saved += 1
        print(f"  Page {page} -> {target.name} ({len(resp.content) // 1024} kB)")
        if delay > 0:
            time.sleep(delay)

    return saved


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch digitized newspaper pages from data.kb.se for a span of years.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            '  %(prog)s -q "Inrikes tidningar" --from-year 1790 --to-year 1792 --list\n'
            '  %(prog)s -q "Inrikes tidningar" --from-year 1790 --to-year 1792 --max-issues 5\n'
        ),
    )
    parser.add_argument("-q", "--query", required=True, help='Newspaper title, e.g. "Inrikes tidningar"')
    parser.add_argument("--from-year", type=int, required=True, help="First year of the span")
    parser.add_argument("--to-year", type=int, required=True, help="Last year of the span (inclusive)")
    parser.add_argument(
        "--title-filter",
        help="Only keep issues whose title contains this text (default: same as --query)",
    )
    parser.add_argument(
        "--max-issues",
        type=int,
        default=5,
        help="Maximum number of issues to download (default: 5; each Gemini extraction costs money)",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=16,
        help="Maximum pages per issue (default: 16; 18th-century papers usually have 4-8)",
    )
    parser.add_argument("--width", type=int, default=1600, help="Downloaded image width in px (default: 1600)")
    parser.add_argument("--delay", type=float, default=1.0, help="Seconds between downloads (default: 1.0)")
    parser.add_argument(
        "--output-dir",
        default=str(DEFAULT_IMAGES_DIR),
        help=f"Where to save page scans (default: {DEFAULT_IMAGES_DIR})",
    )
    parser.add_argument("--list", action="store_true", help="Only list matching issues, download nothing")
    args = parser.parse_args()

    if args.from_year > args.to_year:
        parser.error("--from-year must be <= --to-year")

    from_date = f"{args.from_year}-01-01"
    to_date = f"{args.to_year}-12-31"
    title_filter = args.title_filter or args.query
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f'Searching data.kb.se for "{args.query}" issues, {args.from_year}-{args.to_year}...')

    issues: List[Dict[str, Any]] = []
    try:
        for hit in search_issues(args.query, from_date, to_date, title_filter):
            issues.append(hit)
            if not args.list and len(issues) >= args.max_issues:
                break
    except requests.RequestException as exc:
        print(f"Search failed: {exc}")
        return 1

    if not issues:
        print("No open (out-of-copyright) issues found for that title and year span.")
        print("Tip: try --list with a broader span, or check the title spelling on tidningar.kb.se.")
        return 0

    if args.list:
        print(f"\nFound {len(issues)} issue(s):")
        for hit in issues:
            print(f"  {hit.get('datePublished', '????-??-??')}  {hit.get('title')}  [{hit.get('@id')}]")
        print(f"\nRe-run without --list to download (default --max-issues is {args.max_issues}).")
        return 0

    print(f"Downloading up to {len(issues)} issue(s) into {output_dir}\n")
    total_pages = 0
    for idx, hit in enumerate(issues, start=1):
        print(f"[{idx}/{len(issues)}] {hit.get('title')} ({hit.get('datePublished')})")
        try:
            total_pages += download_issue(hit, output_dir, args.width, args.max_pages, args.delay)
        except requests.RequestException as exc:
            print(f"  Download error: {exc}")

    print(f"\nDone. Saved {total_pages} page(s) across {len(issues)} issue(s).")
    print("Next: python tools/run_pipeline.py   (extracts events and rebuilds the map data)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
