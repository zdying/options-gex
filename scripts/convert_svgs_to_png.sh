#!/usr/bin/env bash
set -u

INPUT_DIR="${1:-data/weekly-gravity/2026-07-10/charts}"
OUTPUT_DIR="${2:-$INPUT_DIR}"
SCALE="${PNG_SCALE:-1}"

if [[ ! -d "$INPUT_DIR" ]]; then
  echo "Input directory not found: $INPUT_DIR" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

if command -v google-chrome >/dev/null 2>&1; then
  CHROME_BIN="$(command -v google-chrome)"
elif command -v chromium >/dev/null 2>&1; then
  CHROME_BIN="$(command -v chromium)"
elif command -v chromium-browser >/dev/null 2>&1; then
  CHROME_BIN="$(command -v chromium-browser)"
else
  echo "Chrome/Chromium is required for accurate SVG to PNG rendering." >&2
  exit 1
fi

svg_dimension() {
  local file="$1"
  local attr="$2"
  local fallback="$3"
  local value

  value="$(grep -oE "${attr}=\"[0-9]+\"" "$file" | head -n 1 | grep -oE '[0-9]+' || true)"
  if [[ -n "$value" ]]; then
    echo "$value"
  else
    echo "$fallback"
  fi
}

to_file_url() {
  local absolute_path="$1"
  printf 'file://%s' "$absolute_path"
}

converted=0
failed=0

while IFS= read -r -d '' svg_path; do
  filename="$(basename "$svg_path")"
  output_path="$OUTPUT_DIR/${filename%.svg}.png"
  absolute_svg="$(realpath "$svg_path")"
  width="$(svg_dimension "$svg_path" width 1200)"
  height="$(svg_dimension "$svg_path" height 800)"

  if "$CHROME_BIN" \
    --headless=new \
    --disable-gpu \
    --no-sandbox \
    --hide-scrollbars \
    --force-device-scale-factor="$SCALE" \
    --window-size="${width},${height}" \
    --screenshot="$output_path" \
    "$(to_file_url "$absolute_svg")" >/dev/null 2>&1; then
    echo "Converted: $svg_path -> $output_path"
    converted=$((converted + 1))
  else
    echo "Failed: $svg_path" >&2
    failed=$((failed + 1))
  fi
done < <(find "$INPUT_DIR" -maxdepth 1 -type f -name '*.svg' -print0 | sort -z)

echo "Done. Converted $converted SVG file(s) to PNG in $OUTPUT_DIR"

if [[ "$failed" -gt 0 ]]; then
  echo "Failed $failed file(s)." >&2
  exit 1
fi
