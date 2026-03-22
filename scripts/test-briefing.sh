#!/bin/bash
# Test-run a briefing task ad-hoc with dedup disabled and a unique filename suffix.
# Usage: test-briefing <type>
#   type: daily | weekly | monthly | product

set -euo pipefail

DB="$HOME/nanoclaw/store/messages.db"
VAULT="$HOME/second-brain/projects/intelligence"
TYPE="${1:-}"

if [[ -z "$TYPE" ]]; then
  echo "Usage: test-briefing <daily|weekly|monthly|product>"
  exit 1
fi

# Helper: escape single quotes for SQL
sql_escape() {
  echo "$1" | sed "s/'/''/g"
}

# Helper: run a SQL update with properly escaped text
sql_update_prompt() {
  local task_id="$1"
  local prompt="$2"
  local escaped
  escaped=$(sql_escape "$prompt")
  sqlite3 "$DB" "UPDATE scheduled_tasks SET prompt = '${escaped}' WHERE id = '${task_id}';"
}

# Map type to task ID, output dir, and base filename pattern
case "$TYPE" in
  daily)
    TASK_ID="daily-briefing"
    OUTPUT_DIR="$VAULT/ai-briefings"
    BASE=$(date +%Y-%m-%d)
    SUBDIR="ai-briefings"
    DEDUP_OVERRIDE="skip the 'Before You Start' section (do NOT read previous briefings) and skip the 'Deduplication Review' section (#6). Do not deduplicate against previous briefings."
    ;;
  weekly)
    TASK_ID="weekly-summary"
    OUTPUT_DIR="$VAULT/weekly-summaries"
    BASE=$(date +%Y-W%V)
    SUBDIR="weekly-summaries"
    DEDUP_OVERRIDE="do not cross-reference or deduplicate against previous weekly summaries."
    ;;
  monthly)
    TASK_ID="monthly-summary"
    OUTPUT_DIR="$VAULT/monthly-summaries"
    BASE=$(date +%Y-%m)
    SUBDIR="monthly-summaries"
    DEDUP_OVERRIDE="do not cross-reference or deduplicate against previous monthly summaries."
    ;;
  product)
    TASK_ID="product-briefing"
    OUTPUT_DIR="$VAULT/product-briefings"
    BASE=$(date +%Y-%m-%d)
    SUBDIR="product-briefings"
    DEDUP_OVERRIDE="skip the 'Before You Start' section (do NOT read previous product briefings). Do not deduplicate against previous briefings."
    ;;
  *)
    echo "Unknown type: $TYPE"
    echo "Usage: test-briefing <daily|weekly|monthly|product>"
    exit 1
    ;;
esac

# Ensure output dir exists
mkdir -p "$OUTPUT_DIR"

# Auto-detect next available suffix (b, c, d, ...)
SUFFIX=""
if [[ -f "$OUTPUT_DIR/${BASE}.md" ]]; then
  for letter in {b..z}; do
    if [[ ! -f "$OUTPUT_DIR/${BASE}${letter}.md" ]]; then
      SUFFIX="$letter"
      break
    fi
  done
  if [[ -z "$SUFFIX" ]]; then
    echo "Error: exhausted suffixes a-z for $BASE"
    exit 1
  fi
fi

OUTFILE="${BASE}${SUFFIX}.md"

# Check that the task exists
TASK_STATUS=$(sqlite3 "$DB" "SELECT status FROM scheduled_tasks WHERE id = '${TASK_ID}';" 2>/dev/null || echo "")
if [[ -z "$TASK_STATUS" ]]; then
  echo "Error: task '$TASK_ID' not found in database"
  exit 1
fi

# Save original prompt and status
ORIGINAL_PROMPT=$(sqlite3 "$DB" "SELECT prompt FROM scheduled_tasks WHERE id = '${TASK_ID}';")
WAS_PAUSED=false

# Build modified prompt — override is placed BEFORE the instructions reference
# so the agent sees it first and doesn't short-circuit after reading existing files
OVERRIDE="IMPORTANT: This is a test run. You MUST create a new briefing file named exactly '${OUTFILE}' in the ${SUBDIR}/ directory. Do NOT skip this because other briefings already exist for today. ${DEDUP_OVERRIDE} Ignore any instruction in the instructions file that says to read previous briefings or deduplicate against them."
NEW_PROMPT="${OVERRIDE} ${ORIGINAL_PROMPT%% and follow them*} and follow them exactly, saving output as ${SUBDIR}/${OUTFILE} instead of the default filename."

# Fallback if the prompt doesn't contain "and follow them"
if echo "$NEW_PROMPT" | grep -q "and follow them exactly, saving"; then
  : # prompt was built successfully
else
  NEW_PROMPT="${OVERRIDE} ${ORIGINAL_PROMPT} Save output as ${SUBDIR}/${OUTFILE} instead of the default filename."
fi

# Activate task if paused
if [[ "$TASK_STATUS" == "paused" ]]; then
  WAS_PAUSED=true
  sqlite3 "$DB" "UPDATE scheduled_tasks SET status = 'active' WHERE id = '${TASK_ID}';"
fi

# Update prompt and set next_run to now
sql_update_prompt "$TASK_ID" "$NEW_PROMPT"
sqlite3 "$DB" "UPDATE scheduled_tasks SET next_run = datetime('now') WHERE id = '${TASK_ID}';"

echo "✓ Triggered $TYPE test run → $OUTFILE"
echo "  Task: $TASK_ID"
echo "  Output: $OUTPUT_DIR/$OUTFILE"
echo "  Dedup: disabled"
echo ""
echo "  Reverting prompt after task runs..."

# Background: wait for the scheduler to pick up the task (next_run moves to future), then revert
(
  for _ in $(seq 1 180); do
    NEXT_RUN=$(sqlite3 "$DB" "SELECT next_run FROM scheduled_tasks WHERE id = '${TASK_ID}';")
    NEXT_TS=$(date -j -f "%Y-%m-%dT%H:%M:%S" "$(echo "$NEXT_RUN" | cut -d. -f1)" +%s 2>/dev/null || echo 0)
    NOW_TS=$(date +%s)
    if [[ "$NEXT_TS" -gt "$NOW_TS" ]]; then
      sql_update_prompt "$TASK_ID" "$ORIGINAL_PROMPT"
      if [[ "$WAS_PAUSED" == true ]]; then
        sqlite3 "$DB" "UPDATE scheduled_tasks SET status = 'paused' WHERE id = '${TASK_ID}';"
      fi
      echo "  ✓ Prompt reverted ($(date +%H:%M:%S))"
      exit 0
    fi
    sleep 5
  done
  # Timeout — revert anyway
  sql_update_prompt "$TASK_ID" "$ORIGINAL_PROMPT"
  if [[ "$WAS_PAUSED" == true ]]; then
    sqlite3 "$DB" "UPDATE scheduled_tasks SET status = 'paused' WHERE id = '${TASK_ID}';"
  fi
  echo "  ⚠ Timed out waiting (15min), prompt reverted anyway"
) &

echo "  (revert running in background, PID $!)"
