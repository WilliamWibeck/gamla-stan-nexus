#!/usr/bin/env python3
"""One-command Nexus data pipeline: newspaper scans -> extraction -> master graph.

Usage:
  python tools/run_pipeline.py            # process new scans, rebuild nexus_master.json
  python tools/run_pipeline.py --watch    # keep running; rebuild whenever scans change
  python tools/run_pipeline.py --force    # reprocess all scans (ignore extraction cache)

Drop newspaper page scans (JPG/PNG) into data_sources/images/ and/or text clippings
(TXT) into data_sources/clippings/. Extraction is cached per file, so only new or
changed scans are sent to the Gemini API. Successfully processed scans are moved to
data_sources/images/done/ automatically.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = PROJECT_ROOT / "tools"
WATCHED_DIRS = [
    PROJECT_ROOT / "data_sources" / "images",
    PROJECT_ROOT / "data_sources" / "clippings",
]
WATCHED_SUFFIXES = {".jpg", ".jpeg", ".png", ".txt"}


def snapshot() -> frozenset:
    """Fingerprint of watched input files (name, size, mtime)."""
    entries = []
    for directory in WATCHED_DIRS:
        if not directory.exists():
            continue
        for path in directory.iterdir():
            if path.is_file() and path.suffix.lower() in WATCHED_SUFFIXES:
                stat = path.stat()
                entries.append((str(path), stat.st_size, stat.st_mtime_ns))
    return frozenset(entries)


def run_once(force: bool) -> bool:
    """Run extract + build. Returns True on success."""
    extract_cmd = [sys.executable, str(TOOLS_DIR / "extract_newspaper_data.py")]
    if force:
        extract_cmd.append("--force")
    build_cmd = [sys.executable, str(TOOLS_DIR / "build_nexus_master.py")]

    for cmd in (extract_cmd, build_cmd):
        print(
            f"\n=== Running: {' '.join(Path(c).name if Path(c).exists() else c for c in cmd)} ===",
            flush=True,
        )
        result = subprocess.run(cmd)
        if result.returncode != 0:
            print(f"Pipeline step failed with exit code {result.returncode}.")
            return False
    print("\nPipeline complete. The app reads public/nexus_master.json on next load.")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the full Nexus data pipeline")
    parser.add_argument(
        "--force", action="store_true", help="Reprocess all scans, ignoring the extraction cache"
    )
    parser.add_argument(
        "--watch", action="store_true", help="Keep running and rebuild when input files change"
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=5.0,
        help="Polling interval in seconds for --watch (default: 5)",
    )
    args = parser.parse_args()

    ok = run_once(force=args.force)
    if not args.watch:
        return 0 if ok else 1

    print(f"\nWatching for new scans in:")
    for directory in WATCHED_DIRS:
        print(f"  {directory}")
    print("Press Ctrl+C to stop.")

    last = snapshot()
    try:
        while True:
            time.sleep(args.interval)
            current = snapshot()
            if current != last:
                print("\nInput change detected — re-running pipeline...")
                # Small settle delay in case files are still being copied in.
                time.sleep(1.0)
                last = snapshot()
                run_once(force=False)
    except KeyboardInterrupt:
        print("\nStopped watching.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
