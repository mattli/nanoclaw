#!/bin/bash
status=$(launchctl list 2>/dev/null | grep com.obsidian-sync)
if [ -z "$status" ]; then
  echo "Obsidian sync service not found"
  exit 1
fi
pid=$(echo "$status" | awk '{print $1}')
exitcode=$(echo "$status" | awk '{print $2}')
if [ "$pid" = "-" ]; then
  echo "Obsidian sync not running (last exit: $exitcode)"
  exit 1
fi
echo "Obsidian sync healthy (pid: $pid)"
