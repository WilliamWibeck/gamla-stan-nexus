#!/usr/bin/env python3
"""Build nexus_master.json for The Nexus dashboard.

This script merges:
1) K-Samsok API records (places/artifacts in Gamla Stan, 1750-1850)
2) Local CSV/JSON files (events, crimes, inventories, tax records)
3) Wikidata SPARQL enrichment (person details and family links)

Output schema:
{
  "nodes": [{ "id", "label", "type", "lat", "lng", "metadata": {} }],
  "links": [{ "source", "target", "relationship", "strength" }]
}
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

try:
    import requests
except ModuleNotFoundError:
    requests = None  # type: ignore[assignment]


KSAMSOK_API = "https://kulturarvsdata.se/ksamsok/api"
WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"

# Gamla Stan (approx) bounding box in WGS84.
GAMLA_STAN_BBOX = (18.045, 59.318, 18.085, 59.332)  # min_lon, min_lat, max_lon, max_lat
TIME_FROM = 1750
TIME_TO = 1850


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


_geocode_record_fn = None


def resolve_record_coordinates(row: Dict[str, Any]) -> Tuple[Optional[float], Optional[float], Optional[str]]:
    """Re-geocode a newspaper record so all sources share canonical street coords."""
    global _geocode_record_fn
    if _geocode_record_fn is None:
        geocode_path = Path(__file__).resolve().parent.parent / "Newscript" / "local_text_test.py"
        spec = importlib.util.spec_from_file_location("local_text_test", geocode_path)
        if spec is None or spec.loader is None:
            return None, None, None
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _geocode_record_fn = mod.geocode_record

    meta = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    locations = [loc for loc in meta.get("locations", []) if isinstance(loc, str)]
    lat, lng, matched_place, _status = _geocode_record_fn(
        row.get("address") or meta.get("address"),
        locations,
        row.get("label"),
        row.get("description"),
        meta.get("original_spelling"),
        online=False,
    )
    return lat, lng, matched_place


def first_match(d: Dict[str, Any], candidates: Iterable[str]) -> Any:
    lower = {k.lower(): v for k, v in d.items()}
    for key in candidates:
        if key.lower() in lower:
            return lower[key.lower()]
    return None


def to_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


@dataclass
class NexusNode:
    id: str
    label: str
    type: str
    lat: Optional[float]
    lng: Optional[float]
    metadata: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "type": self.type,
            "lat": self.lat,
            "lng": self.lng,
            "metadata": self.metadata,
        }


def make_link(source: str, target: str, relationship: str, strength: float) -> Dict[str, Any]:
    return {
        "source": source,
        "target": target,
        "relationship": relationship,
        "strength": round(float(strength), 3),
    }


def fetch_ksamsok_records(
    session: "requests.Session", rows: int = 300
) -> List[Dict[str, Any]]:
    min_lon, min_lat, max_lon, max_lat = GAMLA_STAN_BBOX
    bbox_query = f'/WGS84 "{min_lon} {min_lat} {max_lon} {max_lat}"'
    query = (
        f"boundingBox={bbox_query}"
        f' AND fromTime>="{TIME_FROM}"'
        f' AND toTime<="{TIME_TO}"'
    )

    params = {
        "method": "search",
        "version": "1.1",
        "query": query,
        "hitsPerPage": rows,
        "recordSchema": "presentation",
    }

    app_id = os.getenv("KSAMSOK_APP_ID")
    if app_id:
        params["appid"] = app_id

    response = session.get(KSAMSOK_API, params=params, timeout=25)
    response.raise_for_status()

    payload = response.json()
    records = payload.get("result", {}).get("records", [])
    if isinstance(records, list):
        return records
    return []


def parse_ksamsok_to_nodes(records: List[Dict[str, Any]]) -> List[NexusNode]:
    nodes: List[NexusNode] = []
    for rec in records:
        item_name = first_match(rec, ["itemName", "title", "name"])
        source_uri = first_match(rec, ["sourceUri", "uri", "id"])
        desc = first_match(rec, ["itemDescription", "description"])
        geodata = first_match(rec, ["geodata", "geoData"]) or {}
        lat = to_float(first_match(geodata, ["lat", "latitude"]))
        lng = to_float(first_match(geodata, ["lng", "lon", "longitude"]))
        if lat is None or lng is None:
            continue

        label = str(item_name or "Unnamed heritage object").strip()
        node_id = f"place:ks:{slug(str(source_uri or label))}"
        metadata = {
            "source": "ksamsok",
            "source_uri": source_uri,
            "description": desc,
            "raw_record": rec,
            "kvarter": first_match(rec, ["kvarter", "kvartersnamn", "blockName"]),
            "address": first_match(rec, ["address", "streetAddress", "street"]),
            "time_from": first_match(rec, ["fromTime", "startYear"]),
            "time_to": first_match(rec, ["toTime", "endYear"]),
        }
        nodes.append(NexusNode(node_id, label, "place", lat, lng, metadata))
    return nodes


def read_local_files(local_dir: Path) -> List[Dict[str, Any]]:
    """Read local CSV and JSON files without requiring pandas."""
    all_records: List[Dict[str, Any]] = []
    if not local_dir.exists():
        return all_records

    for file_path in sorted(local_dir.glob("*")):
        if file_path.name.startswith("."):
            continue  # skip hidden files like .extraction_cache.json
        if file_path.suffix.lower() == ".csv":
            try:
                with file_path.open("r", encoding="utf-8") as f:
                    content = f.read(1024)
                    f.seek(0)
                    dialect = csv.Sniffer().sniff(content)
                    f.seek(0)
                    reader = csv.DictReader(f, dialect=dialect)
                    for row in reader:
                        row["_source_file"] = file_path.name
                        all_records.append(row)
            except Exception as e:
                print(f"Warning: Could not parse CSV {file_path.name}: {e}")
        elif file_path.suffix.lower() == ".json":
            try:
                with file_path.open("r", encoding="utf-8") as f:
                    data = json.load(f)
                
                records = []
                if isinstance(data, list):
                    records = data
                elif isinstance(data, dict):
                    if "records" in data and isinstance(data["records"], list):
                        records = data["records"]
                    else:
                        records = [data]
                
                for rec in records:
                    if isinstance(rec, dict):
                        rec["_source_file"] = file_path.name
                        all_records.append(rec)
            except Exception as e:
                print(f"Warning: Could not parse JSON {file_path.name}: {e}")
    return all_records


def parse_local_records(
    records: List[Dict[str, Any]],
) -> Tuple[List[NexusNode], List[Dict[str, Any]], List[str]]:
    nodes: List[NexusNode] = []
    links: List[Dict[str, Any]] = []
    person_names: List[str] = []

    for row_idx, row in enumerate(records):
        source_file = str(row.get("_source_file", "unknown_source"))
        label = first_match(row, ["label", "name", "title", "event_name", "description"])
        if not label:
            label = f"{source_file} entry {row_idx + 1}"

        lat = to_float(first_match(row, ["lat", "latitude"]))
        lng = to_float(first_match(row, ["lng", "lon", "longitude"]))
        inner = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        if inner.get("record_type") in {"Newspaper", "Newspaper Notice"} or row.get("record_type") == "Newspaper Notice":
            resolved_lat, resolved_lng, matched_place = resolve_record_coordinates(row)
            if resolved_lat is not None and resolved_lng is not None:
                lat, lng = resolved_lat, resolved_lng
                if matched_place:
                    inner = dict(inner)
                    inner["matched_place"] = matched_place
                    row = dict(row)
                    row["metadata"] = inner
        kvarter = first_match(row, ["kvarter", "kvartersnamn", "block", "block_name"])
        address = first_match(row, ["address", "street", "street_address"])
        date = first_match(row, ["date", "year", "event_date"])
        node_type = infer_node_type(row, source_file)

        node_id = f"{node_type}:local:{slug(str(label))}:{row_idx}"
        metadata = dict(row)
        metadata["source"] = "local_file"
        metadata["source_file"] = source_file
        metadata["kvarter"] = kvarter
        metadata["address"] = address
        metadata["date"] = date

        nodes.append(NexusNode(node_id, str(label), node_type, lat, lng, metadata))

        resident = first_match(row, ["resident", "person", "person_name", "full_name", "name"])
        if resident and node_type != "person":
            person_id = f"person:local:{slug(str(resident))}"
            person_names.append(str(resident))
            nodes.append(
                NexusNode(
                    person_id,
                    str(resident),
                    "person",
                    None,
                    None,
                    {
                        "source": "local_file",
                        "source_file": source_file,
                        "role": "resident_mentioned",
                    },
                )
            )
            links.append(make_link(person_id, node_id, "witnessed", 0.72))

    return nodes, links, person_names


def infer_node_type(row: Dict[str, Any], source_file: str) -> str:
    # Records from the extraction pipelines are always events.
    inner = row.get("metadata")
    record_type = row.get("record_type") or (inner.get("record_type") if isinstance(inner, dict) else None)
    if record_type == "Newspaper Notice":
        return "event"
    row_text = normalize_text(" ".join(str(v) for v in row.values() if v is not None))
    file_text = normalize_text(source_file)
    joined = f"{row_text} {file_text}"
    if any(k in joined for k in ["resident", "tax", "person", "citizen"]):
        return "person"
    if any(k in joined for k in ["building", "address", "property", "kvarter", "street"]):
        return "place"
    return "event"


def query_wikidata_person(
    session: "requests.Session", person_name: str
) -> Optional[Dict[str, Any]]:
    safe_name = person_name.replace('"', '\\"')
    sparql = f"""
SELECT ?person ?personLabel ?birth ?death ?occupationLabel
       (GROUP_CONCAT(DISTINCT ?parentLabel; separator=", ") AS ?parents)
       (GROUP_CONCAT(DISTINCT ?childLabel; separator=", ") AS ?children)
WHERE {{
  ?person rdfs:label "{safe_name}"@en.
  OPTIONAL {{ ?person wdt:P569 ?birth. }}
  OPTIONAL {{ ?person wdt:P570 ?death. }}
  OPTIONAL {{ ?person wdt:P106 ?occupation. ?occupation rdfs:label ?occupationLabel FILTER (lang(?occupationLabel) = "en") }}
  OPTIONAL {{
    ?person wdt:P22|wdt:P25 ?parent .
    ?parent rdfs:label ?parentLabel FILTER (lang(?parentLabel) = "en")
  }}
  OPTIONAL {{
    ?child wdt:P22|wdt:P25 ?person .
    ?child rdfs:label ?childLabel FILTER (lang(?childLabel) = "en")
  }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,sv". }}
}}
GROUP BY ?person ?personLabel ?birth ?death ?occupationLabel
LIMIT 1
"""
    headers = {"Accept": "application/sparql-results+json"}
    response = session.get(
        WIKIDATA_SPARQL,
        params={"query": sparql, "format": "json"},
        headers=headers,
        timeout=30,
    )
    response.raise_for_status()
    bindings = response.json().get("results", {}).get("bindings", [])
    if not bindings:
        return None
    row = bindings[0]
    return {
        "wikidata_id": row.get("person", {}).get("value"),
        "label": row.get("personLabel", {}).get("value", person_name),
        "birth": row.get("birth", {}).get("value"),
        "death": row.get("death", {}).get("value"),
        "occupation": row.get("occupationLabel", {}).get("value"),
        "parents": row.get("parents", {}).get("value", ""),
        "children": row.get("children", {}).get("value", ""),
    }


def run_spatial_linker(nodes: List[NexusNode]) -> List[Dict[str, Any]]:
    place_nodes = [n for n in nodes if n.type == "place"]
    event_nodes = [n for n in nodes if n.type == "event"]

    place_keys: Dict[str, List[NexusNode]] = {}
    for p in place_nodes:
        k = normalize_text(p.metadata.get("kvarter"))
        a = normalize_text(p.metadata.get("address"))
        for key in {k, a}:
            if key:
                place_keys.setdefault(key, []).append(p)

    links: List[Dict[str, Any]] = []
    for event in event_nodes:
        event_k = normalize_text(event.metadata.get("kvarter"))
        event_a = normalize_text(event.metadata.get("address"))
        candidates = []
        for key in {event_k, event_a}:
            if key and key in place_keys:
                candidates.extend(place_keys[key])
        unique = {c.id: c for c in candidates}.values()
        for place in unique:
            relation = "witnessed"
            strength = 0.92 if event_k and event_k == normalize_text(place.metadata.get("kvarter")) else 0.78
            links.append(make_link(event.id, place.id, relation, strength))
    return links


def run_social_linker(
    session: "requests.Session",
    nodes: List[NexusNode],
    person_names: List[str],
    enable_live: bool,
) -> Tuple[List[NexusNode], List[Dict[str, Any]]]:
    local_people = [n for n in nodes if n.type == "person"]
    names = {n.label for n in local_people}
    names.update(person_names)

    out_nodes: List[NexusNode] = []
    out_links: List[Dict[str, Any]] = []
    if not enable_live:
        return out_nodes, out_links

    local_by_norm = {normalize_text(n.label): n for n in local_people}

    for name in sorted(names):
        if not name:
            continue
        try:
            wd = query_wikidata_person(session, name)
        except Exception:
            continue
        if not wd:
            continue

        person_norm = normalize_text(wd["label"])
        node_id = f"person:wikidata:{slug(person_norm)}"
        out_nodes.append(
            NexusNode(
                node_id,
                wd["label"],
                "person",
                None,
                None,
                {
                    "source": "wikidata",
                    "wikidata_id": wd["wikidata_id"],
                    "birth": wd["birth"],
                    "death": wd["death"],
                    "occupation": wd["occupation"],
                    "parents": wd["parents"],
                    "children": wd["children"],
                },
            )
        )

        local = local_by_norm.get(person_norm)
        if local:
            out_links.append(make_link(local.id, node_id, "related_to", 0.95))

        for parent_name in [n.strip() for n in wd.get("parents", "").split(",") if n.strip()]:
            parent_id = f"person:wikidata:{slug(parent_name)}"
            out_nodes.append(
                NexusNode(
                    parent_id,
                    parent_name,
                    "person",
                    None,
                    None,
                    {"source": "wikidata", "inferred": True, "relation_context": "parent"},
                )
            )
            out_links.append(make_link(parent_id, node_id, "related_to", 0.7))

        for child_name in [n.strip() for n in wd.get("children", "").split(",") if n.strip()]:
            child_id = f"person:wikidata:{slug(child_name)}"
            out_nodes.append(
                NexusNode(
                    child_id,
                    child_name,
                    "person",
                    None,
                    None,
                    {"source": "wikidata", "inferred": True, "relation_context": "child"},
                )
            )
            out_links.append(make_link(node_id, child_id, "related_to", 0.7))

    return out_nodes, out_links


def dedupe_nodes(nodes: List[NexusNode]) -> List[NexusNode]:
    by_key: Dict[Tuple[str, str, Optional[float], Optional[float]], NexusNode] = {}
    for node in nodes:
        key = (
            node.type,
            normalize_text(node.label),
            round(node.lat, 5) if node.lat is not None else None,
            round(node.lng, 5) if node.lng is not None else None,
        )
        existing = by_key.get(key)
        if not existing:
            by_key[key] = node
            continue
        merged = dict(existing.metadata)
        merged.update(node.metadata)
        existing.metadata = merged
    return list(by_key.values())


def dedupe_links(links: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    for link in links:
        key = (link["source"], link["target"], link["relationship"])
        existing = seen.get(key)
        if not existing or link["strength"] > existing["strength"]:
            seen[key] = link
    return list(seen.values())


def ensure_valid_output(payload: Dict[str, Any]) -> None:
    nodes = payload.get("nodes", [])
    links = payload.get("links", [])
    node_ids = {n["id"] for n in nodes}

    required_node_fields = {"id", "label", "type", "lat", "lng", "metadata"}
    for node in nodes:
        missing = required_node_fields - set(node.keys())
        if missing:
            raise ValueError(f"Node missing required fields: {missing}")
        if node["type"] not in {"person", "place", "event"}:
            raise ValueError(f"Unsupported node type: {node['type']}")

    required_link_fields = {"source", "target", "relationship", "strength"}
    for link in links:
        missing = required_link_fields - set(link.keys())
        if missing:
            raise ValueError(f"Link missing required fields: {missing}")
        if link["source"] not in node_ids or link["target"] not in node_ids:
            raise ValueError(f"Link references unknown node: {link}")


def read_extra_json_files(paths: List[Path]) -> List[Dict[str, Any]]:
    """Read additional record arrays (e.g. Newscript/output_json/all_records.json)."""
    records: List[Dict[str, Any]] = []
    for path in paths:
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            print(f"Warning: Could not parse {path}: {e}")
            continue
        if isinstance(data, list):
            for rec in data:
                if isinstance(rec, dict):
                    rec["_source_file"] = path.name
                    records.append(rec)
    return records


def build_payload(
    local_data_dir: Path,
    extra_json: Optional[List[Path]] = None,
    include_ksamsok: bool = False,
) -> Dict[str, Any]:
    session = requests.Session() if requests else None
    if session:
        session.headers.update({"User-Agent": "nexus-data-engine/1.0"})

    all_nodes: List[NexusNode] = []
    all_links: List[Dict[str, Any]] = []
    person_names: List[str] = []
    live_ok = True

    # 1) K-Samsok ingestion (opt-in; newspaper pipeline is the primary source now)
    if session and include_ksamsok:
        try:
            ks_records = fetch_ksamsok_records(session)
            all_nodes.extend(parse_ksamsok_to_nodes(ks_records))
        except Exception:
            live_ok = False
    elif not include_ksamsok:
        pass
    else:
        live_ok = False

    # 2) Local CSV/JSON ingestion (data_sources/ plus extra record files)
    records = read_local_files(local_data_dir)
    records.extend(read_extra_json_files(extra_json or []))
    local_nodes, local_links, local_person_names = parse_local_records(records)
    all_nodes.extend(local_nodes)
    all_links.extend(local_links)
    person_names.extend(local_person_names)

    # 3) Linking logic
    all_links.extend(run_spatial_linker(all_nodes))

    # 4) Wikidata enrichment
    if session:
        wd_nodes, wd_links = run_social_linker(session, all_nodes, person_names, enable_live=live_ok)
        all_nodes.extend(wd_nodes)
        all_links.extend(wd_links)

    # 5) Deduplication
    deduped_nodes = dedupe_nodes(all_nodes)
    node_id_map = {(n.type, normalize_text(n.label)): n.id for n in deduped_nodes}
    remapped_links = []
    for link in all_links:
        source = link["source"]
        target = link["target"]

        # Remap local/generated ids to deduped canonical ids when possible.
        source_node = next((n for n in all_nodes if n.id == source), None)
        target_node = next((n for n in all_nodes if n.id == target), None)
        if source_node:
            source = node_id_map.get((source_node.type, normalize_text(source_node.label)), source)
        if target_node:
            target = node_id_map.get((target_node.type, normalize_text(target_node.label)), target)

        if source == target:
            continue
        remapped_links.append(
            make_link(source, target, link["relationship"], link["strength"])
        )
    deduped_links = dedupe_links(remapped_links)

    payload = {
        "nodes": [n.to_dict() for n in deduped_nodes],
        "links": deduped_links,
    }

    if not payload["nodes"]:
        raise RuntimeError(
            "No nodes produced. Add data under data_sources/ or check K-Samsok/Wikidata connectivity."
        )

    ensure_valid_output(payload)
    return payload


def parse_args() -> argparse.Namespace:
    # Determine script and project root paths
    script_path = Path(__file__).resolve()
    project_root = script_path.parent.parent

    # Default paths relative to project root
    default_local_data_dir = project_root / "data_sources"
    default_output = project_root / "public" / "nexus_master.json"

    parser = argparse.ArgumentParser(description="Build The Nexus master graph JSON")
    parser.add_argument(
        "--local-data-dir",
        default=str(default_local_data_dir),
        help=f"Directory containing local CSV/JSON exports (default: {default_local_data_dir})",
    )
    parser.add_argument(
        "--output",
        default=str(default_output),
        help=f"Output JSON path (default: {default_output})",
    )
    default_newscript = project_root / "Newscript" / "output_json" / "all_records.json"
    parser.add_argument(
        "--extra-json",
        nargs="*",
        default=[str(default_newscript)],
        help=f"Extra JSON record files to ingest (default: {default_newscript})",
    )
    parser.add_argument(
        "--include-ksamsok",
        action="store_true",
        help="Include K-Samsok heritage objects in the graph (off by default)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    local_data_dir = Path(args.local_data_dir)
    output_path = Path(args.output)

    payload = build_payload(
        local_data_dir=local_data_dir,
        extra_json=[Path(p) for p in args.extra_json],
        include_ksamsok=args.include_ksamsok,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(
        f"Wrote {output_path} with {len(payload['nodes'])} nodes and {len(payload['links'])} links."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
