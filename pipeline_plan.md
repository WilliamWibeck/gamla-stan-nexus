# Ingestion Pipeline: Cost-Control & Quality Plan

Development costs and data accuracy are the two biggest challenges when building an AI-powered extraction pipeline. This plan details a cost-conscious, pragmatic roadmap to build a rock-solid database of Gamla Stan's history without breaking the bank.

---

## 1. How We Keep API Costs Under €20 (Even for Thousands of Pages)

Using AI for OCR/transcription is highly cost-effective if managed properly. Here are the four safeguards we will build into our Python code to prevent run-away API costs.

### A. The "Double-Spend" Protection (File Hashing)
Every time you run the pipeline, the script will calculate a SHA-256 hash of each file's contents and check it against `nexus_history.db`.
* If a file's hash is already in the database, the script **completely skips it**.
* You only pay the Gemini API fee **exactly once per document**, even if you run the script every day.

### B. Pre-Processing & Image Downscaling
High-resolution scans from archives (like Riksarkivet) can be 20MB–100MB TIFF/PNG files. Sending these directly to Gemini is expensive and slow.
* **The Solution:** We will add a lightweight image optimization step in Python using `Pillow`.
* The script will automatically resize images to a maximum width of 1600px and compress them into highly optimized JPEGs before sending them to the API. This reduces network payloads by **95%** and drastically lowers the required input tokens.

### C. Gemini 3.5 Flash Model Selection
For standard text extraction, **Gemini 3.5 Flash** is highly capable, extremely fast, and priced at a fraction of the cost of larger models (less than $0.10 per million tokens). Scanning 1,000 pages of text/clippings using Flash will typically cost **less than $5**.

---

## 2. Ensuring "Rock Solid" Extraction (Structured Outputs)

To prevent the AI from outputting malformed JSON or changing the format of the output (which causes your Python code to crash), we will use **Gemini's Structured Outputs (JSON Schema)**.

Instead of hoping the model follows our instructions, we pass a strict JSON schema to the API. The API physically forces the Gemini model to respond in the exact structure we define.

### Example Schema Enforcement:
```json
{
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "label": { "type": "string" },
      "date": { "type": "string" },
      "address": { "type": "string" },
      "description": { "type": "string" },
      "resident": { "type": "string" },
      "record_type": { "type": "string", "enum": ["Newspaper", "Police Record", "Fire Record", "Parish Record", "Other"] }
    },
    "required": ["label", "date", "description", "record_type"]
  }
}
```
If Gemini cannot find an address or resident, it is forced to return `null` rather than a placeholder string like `"unknown"` or `"N/A"`, which simplifies clean-up.

---

## 3. Step-by-Step Implementation Roadmap

We will set up the pipeline in three incremental steps. You can stop or adjust at any point.

```
Step 1: DB & Hash Tracking (No API changes yet)
   └── Verify SHA-256 tracking. Make sure skipped files aren't re-processed.
Step 2: Strict JSON Schema & Cost Control
   └── Implement image resizing and strict JSON schema calls to Gemini.
Step 3: Run a "Dry-Run" Test Batch
   └── Test the pipeline on exactly 3 images. Verify the SQLite outputs, then scale.
```

### Step 1: The Local Database Setup
We will write a small utility script `tools/db.py` to initialize `data_sources/nexus_history.db` with the schema we designed.

### Step 2: Test-First Ingestion Workflow
When developing:
1. Put only **1 or 2** sample documents in the `data_sources/images/` folder.
2. Run the extraction script.
3. Review the database contents.
4. Tweak the prompt if the details (e.g. Swedish spelling or street addresses) are not extracted correctly.
5. Only when the prompts are 100% reliable do you add the rest of your archive.
