#!/bin/bash
# Archive old briefing files based on retention rules in archive-briefings.conf.
# Keeps the N most recent .md files in each folder, moves the rest to _archive/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/archive-briefings.conf"
INTEL_DIR="$HOME/second-brain/resources/intelligence"

if [[ ! -f "$CONFIG" ]]; then
  echo "Error: config not found at $CONFIG"
  exit 1
fi

TOTAL_ARCHIVED=0

while IFS= read -r line; do
  # Skip comments and blank lines
  [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue

  FOLDER=$(echo "$line" | cut -d: -f1)
  RULE=$(echo "$line" | cut -d: -f2)
  KEEP=$(echo "$RULE" | sed 's/keep=//')

  DIR="$INTEL_DIR/$FOLDER"

  if [[ ! -d "$DIR" ]]; then
    echo "⚠ Skipping $FOLDER — directory not found"
    continue
  fi

  if [[ "$KEEP" == "all" ]]; then
    continue
  fi

  # Count .md files (excluding _archive)
  FILE_COUNT=$(find "$DIR" -maxdepth 1 -name "*.md" -type f | wc -l | tr -d ' ')

  if [[ "$FILE_COUNT" -le "$KEEP" ]]; then
    continue
  fi

  # Get files to archive: all .md files except the N most recent
  TO_ARCHIVE=$(ls -t "$DIR"/*.md 2>/dev/null | tail -n +"$((KEEP + 1))")

  if [[ -z "$TO_ARCHIVE" ]]; then
    continue
  fi

  mkdir -p "$DIR/_archive"

  FOLDER_COUNT=0
  while IFS= read -r filepath; do
    mv "$filepath" "$DIR/_archive/"
    FOLDER_COUNT=$((FOLDER_COUNT + 1))
  done <<< "$TO_ARCHIVE"

  TOTAL_ARCHIVED=$((TOTAL_ARCHIVED + FOLDER_COUNT))
  echo "✓ $FOLDER: archived $FOLDER_COUNT files (kept $KEEP)"

done < "$CONFIG"

if [[ "$TOTAL_ARCHIVED" -eq 0 ]]; then
  echo "Nothing to archive"
else
  echo "Done — archived $TOTAL_ARCHIVED files total"
fi
