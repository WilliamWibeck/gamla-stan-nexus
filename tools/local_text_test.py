import os
import sys
import glob
import json
import re
from pathlib import Path
from ollama import chat

# --- KONFIGURATION ---
IMAGE_DIR = "./input_pages"
OUTPUT_DIR = "./output_json"
MODEL_NAME = "qwen2.5vl:7b"

Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)

# --- PROMPT 1: OPTIMERAD OCR (Råtext) ---
OCR_PROMPT = (
    "You are an expert historian and high-precision HTR engine specializing in 18th-century Swedish typography.\n\n"
    "Your sole task is to transcribe the attached image of 'Dagligt Allehanda' from 1780. "
    "Follow these strict rules:\n"
    "1. VERBATIM TRANSCRIPTION: Extract all text exactly as written. Do not modernize spelling.\n"
    "2. GOTHIC TYPOGRAPHY (FRAKTUR): Pay close attention to the long 's' (ſ). Retain abbreviations like 'N:o', 'Kgl.'.\n"
    "3. HISTORICAL CONTEXT MAP: Match degraded characters to these words: 'Tidningar' (not Lidningar), 'Eller', 'Hertigen', 'Högmeſſan', 'Tyſka Kyrkan', 'Förſta'.\n"
    "4. FRAKTUR WARNINGS: 'ſ' vs 'f', 'B' vs 'V' (e.g., Betjent, Boklåda), 'K' vs 'R' (e.g., Kungörelse, Räkenskaper).\n"
    "5. NO COMMENTARY: Output ONLY the raw transcribed text. Maintain line breaks where possible."
)

# --- PROMPT 2: JSON EXTRAKTION (Struktur & Entiteter) ---
JSON_PROMPT = """
You are a specialized data extraction pipeline for the "Gamla Stan Nexus" database.
Analyze the transcribed 18th-century text. Divide into notices.

STRICT INSTRUCTIONS:
1. ENTITIES FIRST: Before writing the description, list all names (people) and their exact roles found in the text. If no people are mentioned, return an empty array.
2. ACCURATE LABELING: The "label" must be based on the ACTUAL content of the notice (e.g., "Försäljning av blomlökar"), NOT a generic category name. 
3. LOCATION CLEANING: Extract streets/buildings cleanly. Do not include price/floor info in the address field (e.g., move '3 trappor up' to description).

OUTPUT FORMAT: (Return valid JSON array)
[
  {
    "label": "Accurate summary title based on actual content",
    "date": "YYYY-MM-DD or null",
    "address": "Clean street/building name",
    "description": "Modernized summary",
    "metadata": {
      "original_spelling": "Verbatim text",
      "people": [{"name": "Name", "role": "Role"}],
      "locations": ["List of cleaned locations"],
      "themes": ["List of categories"]
    }
  }
]
"""

def extract_json_from_response(response_text):
    """Städar bort eventuell markdown från AI-svaret."""
    # Använder strängkonkatenering för att undvika att markdown-tolkaren bryter filen
    pattern = r'`' * 3 + r'(?:json)?\s*([\s\S]*?)\s*' + r'`' * 3
    match = re.search(pattern, response_text)
    if match:
        return match.group(1)
    return response_text.strip()

def process_images():
    image_extensions = ("*.jpg", "*.jpeg", "*.png", "*.JPG", "*.JPEG", "*.PNG")
    all_images = []
    for ext in image_extensions:
        all_images.extend(glob.glob(os.path.join(IMAGE_DIR, ext)))

    all_images = sorted(all_images)
    total_files = len(all_images)

    if total_files == 0:
        print(f"Inga bilder hittades i '{IMAGE_DIR}'.")
        return

    print(f"Startar Gamla Stan Nexus Pipeline: {total_files} filer att bearbeta.\n" + "="*50)

    for idx, img_path in enumerate(all_images, start=1):
        file_name = Path(img_path).name
        stem_name = Path(img_path).stem
        output_file_path = os.path.join(OUTPUT_DIR, f"{stem_name}.json")
        
        # Om JSON-filen redan finns, skippa och gå till nästa (bra om skriptet kraschar/pausas)
        if os.path.exists(output_file_path):
            print(f"[{idx}/{total_files}] Hoppar över {file_name} (JSON finns redan)")
            continue
            
        print(f"[{idx}/{total_files}] Bearbetar {file_name}...")
        
        try:
            # STEG 1: Bild till Råtext (Vision OCR)
            print("  -> Kör OCR-transkription (Vision)...", end="", flush=True)
            ocr_response = chat(
                model=MODEL_NAME,
                messages=[{
                    'role': 'user',
                    'content': OCR_PROMPT,
                    'images': [img_path]
                }],
                options={'num_ctx': 8192}
            )
            raw_text = ocr_response['message']['content']
            print(" KLART")

            # STEG 2: Råtext till JSON (Text Extraktion)
            print("  -> Extraherar entiteter till JSON...", end="", flush=True)
            
            # Vi injicerar filnamnet dynamiskt i prompten så det hamnar rätt i "archive_ref"
            dynamic_json_prompt = JSON_PROMPT.replace("<FILENAME_PLACEHOLDER>", file_name) + "\n" + raw_text

            json_response = chat(
                model=MODEL_NAME,
                messages=[{
                    'role': 'user',
                    'content': dynamic_json_prompt
                }],
                options={'num_ctx': 8192} # Behöver context för att hålla hela texten och bygga JSON
            )
            
            raw_json_output = json_response['message']['content']
            clean_json_string = extract_json_from_response(raw_json_output)
            
            # Validera att outputen faktiskt är läsbar JSON innan vi sparar
            parsed_json = json.loads(clean_json_string)
            
            with open(output_file_path, "w", encoding="utf-8") as f:
                json.dump(parsed_json, f, ensure_ascii=False, indent=2)
                
            print(" KLART OCH SPARAT!")

        except json.JSONDecodeError:
            print(" FEL! Modellen returnerade ogiltig JSON. Sparar råtexten för felsökning.")
            with open(output_file_path.replace(".json", "_error.txt"), "w", encoding="utf-8") as f:
                f.write(raw_json_output)
        except Exception as e:
            print(f" KRASCH! Ett fel uppstod: {e}")

if __name__ == "__main__":
    process_images()