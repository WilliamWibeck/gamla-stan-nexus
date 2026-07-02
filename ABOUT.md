# Nexus · Gamla Stan

**Nexus** is an interactive historical exploration tool for [Gamla Stan](https://en.wikipedia.org/wiki/Gamla_stan) — Stockholm’s Old Town. It connects people, places, and events on a map and in a relationship graph, so you can move through time and follow thematic threads rather than reading a linear narrative.

The current proof of concept centers on the late Gustavian era, especially the court, daily life in the district, security concerns, and the conspiracy surrounding Gustav III’s assassination in 1792.

## What it does

Nexus presents history as a **split-view dashboard**:

| View | Role |
|------|------|
| **Map** | Geographic context — locations, routes, and spatial links across Gamla Stan |
| **Graph** | Relational context — who knew whom, who was present where, and how events connect |
| **Time axis** | A global year slider that shows only entities active in the selected year |
| **Threads** | Optional theme filters (e.g. court life, security, conspiracy) to narrow the dossier |

Hovering or selecting an entity in one view highlights the corresponding node in the other, so the map and graph stay in sync as you explore.

The map also layers in **K-Samsok** heritage records (Swedish cultural heritage API) as reference points alongside the curated historical graph.

## Data model

The app works with a graph of **nodes** and **links**:

- **Nodes** — people, places, or events, each with a time range (`yearStart`–`yearEnd`), optional coordinates, and one or more themes.
- **Links** — relationships between nodes (e.g. *assassinated at*, *conspired with*, *resided at*), optionally tagged with themes.

At runtime the dataset is filtered by the selected year and active themes. Only nodes that fall within the year window and match the theme filter (if any) are shown; links are kept only when both endpoints are visible.

### Data sources

A Python build script (`tools/build_nexus_master.py`) assembles the master dataset by merging:

1. **[K-Samsok](https://kulturarvsdata.se/ksamsok/)** — places and artifacts in Gamla Stan, roughly 1750–1850, via bounding-box search
2. **Local CSV/JSON** — events, crimes, inventories, tax records, and other structured sources
3. **[Wikidata](https://www.wikidata.org/)** — SPARQL enrichment for people, families, and biographical links

The output is `public/nexus_master.json`. The frontend loads this at startup and shows an error state if the file is missing or empty.

## Data sources (on disk)

```
data_sources/
  extracted_newspapers.json   # Structured events from newspaper OCR / extraction
  .extraction_cache.json      # Per-scan Gemini results keyed by content hash
  images/                     # Source page scans (e.g. Inrikes Tidningar)
  clippings/                  # Optional raw text clippings for regex extraction
public/
  nexus_master.json           # Built graph consumed by the app
  ksamsok_raw.json            # Cached K-Samsok heritage records for the map overlay
```

## Scan-to-map workflow

The intended workflow is: **drop newspaper scans into a folder and everything else is automated.**

```bash
# one-off: process new scans and rebuild the master graph
python tools/run_pipeline.py

# or keep it running: rebuilds automatically when files are added/changed
python tools/run_pipeline.py --watch
```

1. Place page scans (JPG/PNG) in `data_sources/images/` — or fetch them
   automatically:
   - `tools/fetch_kb_newspapers.py` downloads digitized newspaper pages straight
     from Kungliga biblioteket (data.kb.se) for a title and span of years, e.g.

     ```bash
     # preview what's available
     python tools/fetch_kb_newspapers.py -q "Inrikes tidningar" --from-year 1790 --to-year 1792 --list
     # download 5 issues (all pages of each) into data_sources/images/
     python tools/fetch_kb_newspapers.py -q "Inrikes tidningar" --from-year 1790 --to-year 1792 --max-issues 5
     ```

     Only out-of-copyright material (older than ~150 years) is openly available.
     Already-downloaded pages are skipped, so re-runs are cheap.
   - `tools/fetch_archives.py` (K-Samsok search or Riksarkivet IIIF manifests).
2. `tools/extract_newspaper_data.py` sends each scan to the Gemini API (needs
   `GEMINI_API_KEY` in `.env`), which transcribes the old Swedish text and returns
   structured events (label, date, address, people, crime/fire/parish details, and a
   faithful original-spelling transcription).
3. Each extraction is cached by file hash in `data_sources/.extraction_cache.json`,
   so re-runs only pay for new or changed scans, and a failed API call never wipes
   earlier results.
4. Addresses are geocoded against a local Gamla Stan gazetteer (diacritic-tolerant,
   longest-name-first, with a description-text fallback). Records with no match land
   at the district center and are flagged `location_approximate` in their metadata.
5. `tools/build_nexus_master.py` merges the extracted events with K-Samsok and
   Wikidata enrichment into `public/nexus_master.json`, which the app loads.

## Tech stack

- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS
- **Map:** Mapbox GL JS (requires `VITE_MAPBOX_ACCESS_TOKEN` in `.env`)
- **Graph:** `react-force-graph-2d` for the mind-map panel
- **Data pipeline:** Python (`pandas`, `requests`) for ingestion and graph assembly

## Project layout

```
src/
  App.tsx                 # Main layout and state (year, themes, highlight sync)
  components/
    NexusMap.tsx          # Mapbox map + historical markers and links
    NexusMindmap.tsx      # Force-directed relationship graph
    NexusSidebar.tsx      # Theme filters and chrome
    NexusTimeBar.tsx      # Global year slider
  lib/
    nexusPoc.ts           # Dataset types, filtering, map/graph adapters
    nexusHistoricalGraph.ts  # Mapbox layers for nodes and animated links
tools/
  run_pipeline.py         # One command: scans -> extraction -> master graph (has --watch)
  fetch_kb_newspapers.py  # Download newspaper pages from KB (data.kb.se) by title + year span
  fetch_archives.py       # Download scans from K-Samsok / Riksarkivet IIIF
  build_nexus_master.py   # Merge external sources into nexus_master.json
  extract_newspaper_data.py  # OCR / regex extraction into extracted_newspapers.json
public/
  nexus_master.json       # Generated master graph
  ksamsok_raw.json        # Cached K-Samsok heritage records
data_sources/
  extracted_newspapers.json
  images/
  clippings/
```

## Running locally

```bash
npm install
cp .env.example .env   # add your Mapbox token
npm run dev
```

To rebuild the dataset from scans (see the scan-to-map workflow above):

```bash
python tools/run_pipeline.py
```

See `README.md` for standard Vite/React tooling notes.

## Status

The UI, linking behavior, and data pipeline are in place. Coverage grows as new newspaper scans and archival sources are added under `data_sources/`.
