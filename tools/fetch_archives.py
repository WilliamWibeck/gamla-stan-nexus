#!/usr/bin/env python3
"""Archival Downloader (Polite API Crawler) for Swedish Historical Records.

This script can:
1) Automatically search K-Samsok (Swedish Open Cultural Heritage) for records/images
   matching a search query, download the images, and generate metadata text files.
2) Fetch a specific IIIF manifest from Riksarkivet and download individual pages
   pre-scaled to save bandwidth and token costs.
"""

import argparse
import json
import os
import re
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
DEFAULT_IMAGES_DIR = PROJECT_ROOT / "data_sources" / "images"
DEFAULT_CLIPPINGS_DIR = PROJECT_ROOT / "data_sources" / "clippings"
KSAMSOK_API = "https://kulturarvsdata.se/ksamsok/api"


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip().lower()
    text = re.sub(r"\s+", " ", text)
    text = (
        text.replace("å", "a")
        .replace("ä", "a")
        .replace("ö", "o")
        .replace("é", "e")
        .replace("ü", "u")
    )
    text = re.sub(r"[^a-z0-9 ]+", "", text)
    return text.strip()


def slug(value: str) -> str:
    txt = normalize_text(value)
    txt = re.sub(r"\s+", "-", txt)
    return txt or "unknown"


def first_match(d: Dict[str, Any], candidates: List[str]) -> Any:
    lower = {k.lower(): v for k, v in d.items()}
    for key in candidates:
        if key.lower() in lower:
            return lower[key.lower()]
    return None


def fetch_iiif_manifest(manifest_url: str) -> Optional[Dict[str, Any]]:
    """Retrieve a IIIF manifest JSON containing page URLs for a specific archive."""
    print(f"Fetching manifest from: {manifest_url}...")
    headers = {"User-Agent": "NexusGamlaStanCrawler/1.0"}
    try:
        response = requests.get(manifest_url, headers=headers, timeout=20)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"Error fetching manifest: {e}")
        return None


def download_pages_from_manifest(
    manifest: Dict[str, Any],
    output_dir: Path,
    max_pages: int,
    target_width: int,
    prefix: str,
    delay: float
) -> int:
    """Parse manifest and download individual page images pre-scaled."""
    sequences = manifest.get("sequences", [])
    if not sequences:
        items = manifest.get("items", [])
        canvases = [item for item in items if item.get("type") == "Canvas"]
    else:
        canvases = sequences[0].get("canvases", [])

    if not canvases:
        print("Error: No pages (canvases) found in the manifest.")
        return 0

    output_dir.mkdir(parents=True, exist_ok=True)
    download_count = 0

    print(f"Found {len(canvases)} total pages in document. Starting download (Limit: {max_pages} pages)...")

    for idx, canvas in enumerate(canvases):
        if download_count >= max_pages:
            print(f"Reached request limit of {max_pages} pages. Stopping.")
            break

        images = canvas.get("images", [])
        image_service_url = None

        if images:
            resource = images[0].get("resource", {})
            service = resource.get("service", {})
            image_service_url = service.get("@id")
        else:
            items = canvas.get("items", [])
            if items:
                anno_page = items[0]
                annotations = anno_page.get("items", [])
                if annotations:
                    body = annotations[0].get("body", {})
                    service = body.get("service", [])
                    if service:
                        image_service_url = service[0].get("id") or service[0].get("@id")

        if not image_service_url:
            print(f"Warning: Could not locate IIIF image service for page {idx + 1}. Skipping.")
            continue

        image_service_url = image_service_url.rstrip("/")
        download_url = f"{image_service_url}/full/{target_width},/0/default.jpg"
        
        filename = f"{prefix}_{idx + 1:04d}.jpg"
        target_path = output_dir / filename

        if target_path.exists():
            print(f"Page {idx + 1} already downloaded: {filename}. Skipping.")
            download_count += 1
            continue

        print(f"Downloading Page {idx + 1}/{len(canvases)} -> {filename}...")
        try:
            headers = {"User-Agent": "NexusGamlaStanCrawler/1.0"}
            img_res = requests.get(download_url, headers=headers, timeout=30)
            img_res.raise_for_status()

            with target_path.open("wb") as out_file:
                out_file.write(img_res.content)
            
            download_count += 1
            if delay > 0:
                time.sleep(delay)

        except Exception as e:
            print(f"Failed to download page {idx + 1}: {e}")

    return download_count


def search_ksamsok(query_term: str, max_results: int) -> List[Dict[str, Any]]:
    """Query K-Samsok API for search results matching a query term, filtered to items with images."""
    print(f"Searching K-Samsok API for: '{query_term}'...")
    
    # We query for records with thumbnails to guarantee digitized assets
    query = f'text="{query_term}" AND thumbnailExists="j"'
    
    params = {
        "method": "search",
        "version": "1.1",
        "query": query,
        "hitsPerPage": max_results,
        "recordSchema": "presentation"
    }
    
    headers = {
        "Accept": "application/json",
        "User-Agent": "NexusGamlaStanCrawler/1.0"
    }
    
    try:
        response = requests.get(KSAMSOK_API, params=params, headers=headers, timeout=25)
        response.raise_for_status()
        payload = response.json()
        
        # Extract the records list from the nested dictionary
        records_dict = payload.get("result", {}).get("records", {})
        if isinstance(records_dict, dict):
            records = records_dict.get("record", [])
        elif isinstance(records_dict, list):
            records = records_dict
        else:
            records = []
            
        return records
    except Exception as e:
        print(f"Error querying K-Samsok API: {e}")
        return []


def download_discovered_records(
    records: List[Dict[str, Any]],
    images_dir: Path,
    clippings_dir: Path,
    delay: float
) -> int:
    """Download images and create metadata text files for discovered K-Samsok records."""
    download_count = 0
    images_dir.mkdir(parents=True, exist_ok=True)
    clippings_dir.mkdir(parents=True, exist_ok=True)

    print(f"\nProcessing {len(records)} discovered search result records...")

    for idx, raw_record in enumerate(records):
        rec = raw_record.get("pres:item", {}) if isinstance(raw_record, dict) else {}
        if not rec:
            rec = raw_record
            
        item_name = rec.get("pres:itemLabel") or rec.get("itemName") or rec.get("title") or "Okänd historisk post"
        desc = rec.get("pres:description") or rec.get("itemDescription") or ""
        source_uri = rec.get("pres:entityUri") or rec.get("sourceUri") or rec.get("id")
        organization = rec.get("pres:organization") or rec.get("serviceName") or "K-Samsok"
        
        # Try to resolve direct image source URLs
        image_url = None
        image_info = rec.get("pres:image", {})
        if isinstance(image_info, dict):
            src_list = image_info.get("pres:src", [])
            if isinstance(src_list, list):
                # Try highres, then fallback to others
                for src in src_list:
                    if isinstance(src, dict) and src.get("type") == "highres":
                        image_url = src.get("content")
                        break
                if not image_url and src_list:
                    image_url = src_list[0].get("content")
            elif isinstance(src_list, dict):
                image_url = src_list.get("content")
        
        if not image_url:
            image_url = first_match(rec, ["highresSource", "lowresSource", "thumbnailSource"])

        if not image_url:
            print(f"Skipping record {idx + 1} (No image source found): {item_name}")
            continue

        # Extract date from context
        time_from = "1790"
        context = rec.get("pres:context", {})
        if isinstance(context, dict):
            time_label = context.get("pres:timeLabel")
            if time_label:
                year_match = re.search(r"\b(\d{4})\b", str(time_label))
                if year_match:
                    time_from = year_match.group(1)

        address = "Gamla Stan"
        if isinstance(context, dict):
            place_label = context.get("pres:placeLabel")
            if place_label:
                for street in ["stortorget", "jarntorget", "osterlanggatan", "vasterlanggatan", "svartmangatan", "skomakargatan", "skeppsbron"]:
                    if street in str(place_label).lower() or street in str(desc).lower():
                        address = street.title()
                        break

        record_slug = slug(str(source_uri or item_name))
        img_filename = f"ks_{record_slug[:50]}.jpg"
        txt_filename = f"ks_{record_slug[:50]}.txt"

        img_path = images_dir / img_filename
        txt_path = clippings_dir / txt_filename

        if img_path.exists() and txt_path.exists():
            print(f"Record {idx + 1} already downloaded: {img_filename}. Skipping.")
            download_count += 1
            continue

        print(f"Downloading image for Record {idx + 1}: {item_name} -> {img_filename}...")
        try:
            img_res = requests.get(image_url, headers={"User-Agent": "NexusGamlaStanCrawler/1.0"}, timeout=20)
            img_res.raise_for_status()
            with img_path.open("wb") as f:
                f.write(img_res.content)
            
            # Create accompanying text metadata file for the extraction workflow
            content_text = (
                f"DATE: {time_from}\n"
                f"SOURCE: {organization}\n"
                f"TYPE: Historical Record\n"
                f"ADDRESS: {address}\n"
                f"CONTENT: {desc if desc else item_name}\n"
            )
            with txt_path.open("w", encoding="utf-8") as f:
                f.write(content_text)
                
            download_count += 1
            if delay > 0:
                time.sleep(delay)
        except Exception as e:
            print(f"Failed to process K-Samsok record '{item_name}': {e}")

    return download_count


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Auto-discover and download digitized Swedish historical records/images."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--query",
        help="Search query to auto-discover and download documents from K-Samsok (e.g. 'Gamla Stan brand')",
    )
    group.add_argument(
        "--manifest",
        help="Specific IIIF manifest URL to download page-by-page (e.g. https://lbiiif.riksarkivet.se/manifest/arkiv/...)",
    )
    
    parser.add_argument(
        "--output-dir",
        default=str(DEFAULT_IMAGES_DIR),
        help=f"Directory to save images (default: {DEFAULT_IMAGES_DIR})",
    )
    parser.add_argument(
        "--max-results",
        type=int,
        default=5,
        help="Maximum records/pages to download in this run (default: 5 for dev budget safety)",
    )
    parser.add_argument(
        "--width",
        type=int,
        default=1600,
        help="IIIF target image width to request (default: 1600)",
    )
    parser.add_argument(
        "--prefix",
        default="archive_doc",
        help="Prefix filename for manifest page downloads (default: archive_doc)",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=1.0,
        help="Polite scraper delay in seconds between downloads (default: 1.0)",
    )
    args = parser.parse_args()

    images_dir = Path(args.output_dir)
    clippings_dir = DEFAULT_CLIPPINGS_DIR

    if args.query:
        records = search_ksamsok(args.query, args.max_results)
        if not records:
            print("No records found matching query.")
            return 0
        
        downloaded = download_discovered_records(
            records=records,
            images_dir=images_dir,
            clippings_dir=clippings_dir,
            delay=args.delay
        )
        print(f"\nDone! Auto-discovered and saved {downloaded} records to local directory.")
        print(f"Images are in: {images_dir}")
        print(f"Metadata files are in: {clippings_dir}")
        print("\nNext, run the extraction pipeline:")
        print("  python tools/extract_newspaper_data.py")
        print("  python tools/build_nexus_master.py")
        
    elif args.manifest:
        manifest = fetch_iiif_manifest(args.manifest)
        if not manifest:
            return 1

        downloaded = download_pages_from_manifest(
            manifest=manifest,
            output_dir=images_dir,
            max_pages=args.max_results,
            target_width=args.width,
            prefix=args.prefix,
            delay=args.delay
        )
        print(f"\nDone! Successfully saved {downloaded} page(s) to {images_dir}.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
