---
name: last30days-research
description: Research topics using Reddit and X via the last30days engine. Writes an IPC request to the host, which runs the Python scripts with API keys and returns structured findings.
allowed-tools: Bash, Write, Read
---

# last30days Research Tool

Research any topic using Reddit and X as data sources. The research runs on the host machine (where API keys and browser tokens live) via IPC.

## How to Use

Write a JSON file to `/workspace/ipc/tasks/` with the research request. The host picks it up, runs the last30days Python scripts, and writes results back.

### Step 1: Write the IPC Request

```bash
cat > /workspace/ipc/tasks/$(date +%s)-$(head -c 4 /dev/urandom | xxd -p).json <<'IPCEOF'
{
  "type": "last30days_research",
  "requestId": "l30d-UNIQUE_ID",
  "topics": "your topic here",
  "flags": "",
  "groupFolder": "GROUP_FOLDER",
  "timestamp": "TIMESTAMP"
}
IPCEOF
```

**Fields:**
- `type`: Always `"last30days_research"`
- `requestId`: Unique ID for matching the result. Use format `l30d-{timestamp}-{random}`
- `topics`: One or more topics. Separate multiple topics with `|||` (triple pipe)
- `flags`: Optional. `"--search x"` for X only, `"--search reddit"` for Reddit only, `"--quick"` or `"--deep"`
- `groupFolder`: Your group folder name (from `NANOCLAW_GROUP_FOLDER` env var)
- `timestamp`: ISO timestamp

### Step 2: Poll for Results

Results appear at `/workspace/ipc/last30days_results/{requestId}.json`. Poll every 2-3 seconds. Research typically takes 1-5 minutes.

```bash
# Poll for result (timeout after 10 minutes)
REQUEST_ID="l30d-your-id-here"
for i in $(seq 1 300); do
  if [ -f "/workspace/ipc/last30days_results/${REQUEST_ID}.json" ]; then
    cat "/workspace/ipc/last30days_results/${REQUEST_ID}.json"
    rm "/workspace/ipc/last30days_results/${REQUEST_ID}.json"
    break
  fi
  sleep 2
done
```

The result JSON has:
```json
{
  "success": true,
  "message": "... full research output ..."
}
```

### Complete Example

```bash
# Generate unique request ID
REQ_ID="l30d-$(date +%s)-$(head -c 4 /dev/urandom | xxd -p)"
GROUP="${NANOCLAW_GROUP_FOLDER}"
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

# Write IPC request
cat > "/workspace/ipc/tasks/$(date +%s)-$(head -c 4 /dev/urandom | xxd -p).json" <<EOF
{
  "type": "last30days_research",
  "requestId": "${REQ_ID}",
  "topics": "AI coding assistants ||| developer tools trending",
  "flags": "--search x",
  "groupFolder": "${GROUP}",
  "timestamp": "${NOW}"
}
EOF

# Wait for result
for i in $(seq 1 300); do
  if [ -f "/workspace/ipc/last30days_results/${REQ_ID}.json" ]; then
    cat "/workspace/ipc/last30days_results/${REQ_ID}.json"
    rm "/workspace/ipc/last30days_results/${REQ_ID}.json"
    break
  fi
  sleep 2
done
```

## Tips

- Default searches both Reddit and X. Use `--search x` to restrict to X only.
- For product briefings, research 3-5 focused topics and synthesize the results.
- The research output includes engagement stats, key quotes, and source citations.
- If a topic returns no results, try broader terms or remove qualifiers.
