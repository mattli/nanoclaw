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

# Revert directory for crash recovery
REVERT_DIR="/tmp/test-briefing-revert"
mkdir -p "$REVERT_DIR"
REVERT_FILE="$REVERT_DIR/${TASK_ID}.prompt"

# If a previous revert file exists, a prior test run's revert failed — restore it now
if [[ -f "$REVERT_FILE" ]]; then
  echo "⚠ Found unrevertd prompt from a previous test run — restoring it first"
  STALE_PROMPT=$(cat "$REVERT_FILE")
  sql_update_prompt "$TASK_ID" "$STALE_PROMPT"
  rm -f "$REVERT_FILE"
  echo "  ✓ Previous prompt restored"
fi

# Save original prompt and status
ORIGINAL_PROMPT=$(sqlite3 "$DB" "SELECT prompt FROM scheduled_tasks WHERE id = '${TASK_ID}';")
WAS_PAUSED=false

# Persist original prompt to disk so it can be recovered even if the background revert dies
echo "$ORIGINAL_PROMPT" > "$REVERT_FILE"

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

# Background: wait for the scheduler to pick up the task (next_run moves to future), then revert.
# Uses nohup so the process survives terminal close.
REVERT_LOG="$REVERT_DIR/${TASK_ID}.log"
nohup bash -c '
  DB="'"$DB"'"
  TASK_ID="'"$TASK_ID"'"
  REVERT_FILE="'"$REVERT_FILE"'"
  WAS_PAUSED="'"$WAS_PAUSED"'"

  sql_escape() { echo "$1" | sed "s/'"'"'/'"'"''"'"'/g"; }
  sql_update_prompt() {
    local escaped
    escaped=$(sql_escape "$2")
    sqlite3 "$DB" "UPDATE scheduled_tasks SET prompt = '"'"'${escaped}'"'"' WHERE id = '"'"'${1}'"'"';"
  }

  revert_prompt() {
    local orig
    orig=$(cat "$REVERT_FILE")
    sql_update_prompt "$TASK_ID" "$orig"
    if [[ "$WAS_PAUSED" == true ]]; then
      sqlite3 "$DB" "UPDATE scheduled_tasks SET status = '"'"'paused'"'"' WHERE id = '"'"'${TASK_ID}'"'"';"
    fi
    rm -f "$REVERT_FILE"
  }

  # Record the next_run at trigger time so we can detect when the scheduler advances it
  INITIAL_NEXT_RUN=$(sqlite3 "$DB" "SELECT next_run FROM scheduled_tasks WHERE id = '"'"'${TASK_ID}'"'"';")

  for _ in $(seq 1 180); do
    CURRENT_NEXT_RUN=$(sqlite3 "$DB" "SELECT next_run FROM scheduled_tasks WHERE id = '"'"'${TASK_ID}'"'"';")
    if [[ "$CURRENT_NEXT_RUN" != "$INITIAL_NEXT_RUN" ]]; then
      revert_prompt
      echo "  ✓ Prompt reverted ($(date +%H:%M:%S))"
      exit 0
    fi
    sleep 5
  done

  # Timeout (15min) — revert anyway
  revert_prompt
  echo "  ⚠ Timed out waiting (15min), prompt reverted anyway"
' > "$REVERT_LOG" 2>&1 &
disown

echo "  (revert running in background, PID $!, log: $REVERT_LOG)"
