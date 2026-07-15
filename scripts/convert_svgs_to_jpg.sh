#!/usr/bin/env bash
set -euo pipefail

INPUT_DIR="${1:-data/weekly-gravity/2026-07-10/charts}"
OUTPUT_DIR="${2:-$INPUT_DIR}"
QUALITY="${JPG_QUALITY:-95}"
BACKGROUND="${JPG_BACKGROUND:-white}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PNG_SCRIPT="$SCRIPT_DIR/convert_svgs_to_png.sh"

if [[ ! -x "$PNG_SCRIPT" ]]; then
  echo "PNG converter not found or not executable: $PNG_SCRIPT" >&2
  exit 1
fi

if ! command -v convert >/dev/null 2>&1; then
  echo "ImageMagick convert is required to encode JPG from PNG." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/svg-to-jpg-png.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT

"$PNG_SCRIPT" "$INPUT_DIR" "$TEMP_DIR"

count=0
while IFS= read -r -d '' png_path; do
  filename="$(basename "$png_path")"
  output_path="$OUTPUT_DIR/${filename%.png}.jpg"
  convert "$png_path" \
    -background "$BACKGROUND" \
    -alpha remove \
    -alpha off \
    -quality "$QUALITY" \
    "$output_path"
  echo "Converted: $png_path -> $output_path"
  count=$((count + 1))
done < <(find "$TEMP_DIR" -maxdepth 1 -type f -name '*.png' -print0 | sort -z)

echo "Done. Converted $count SVG file(s) to JPG in $OUTPUT_DIR"
