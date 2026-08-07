#!/bin/bash
# Unattended dotfiles sync — a BACKSTOP for the Claude Code SessionStart/SessionEnd
# hooks, not a replacement. The hooks still do the normal syncing at natural
# "I'm done" boundaries; this catches the case they can't: a Claude Code session
# left running for days, so SessionEnd never fires and dotfiles go stale.
#
# Registered as NanoClaw scheduled task `dotfiles-sync` (context_mode=script,
# cron 5,35 * * * * — offset from vault-sync at */30 so the logs stay readable).
#
# Unlike vault-sync, this repo has TWO real git working trees (Mini + MacBook),
# so it must pull. That is a failure mode vault-sync does not have: the vault's
# MacBook copy is an Obsidian Sync mirror with no .git, so only one writer exists
# and nothing can ever diverge. Here both machines commit on their own schedule.
#
# The hard rule for an unattended job: NEVER leave the repo mid-rebase. A wedged
# rebase would break every later run and any interactive git use, and would go
# unnoticed for hours.
#
# Failure reporting: the scheduler builds its Telegram message from stderr, and
# only pings on a non-zero exit (src/task-scheduler.ts). So errors go to stderr
# and real failures must exit non-zero. Success stays silent by design — the
# task's display_name is empty, which suppresses the "done" ping.

cd /Users/mattli/dotfiles || exit 1
export GIT_TERMINAL_PROMPT=0

# 1. Commit local work FIRST. This is what makes a conflict recoverable: it
#    becomes a rebase we can cleanly abort, rather than a mangled working tree.
git add -A
git diff --cached --quiet || git commit -q -m "dotfiles auto-sync $(date +%F\ %H:%M)"

# 2. Integrate the remote. --rebase keeps history linear. No --autostash needed:
#    step 1 already left the tree clean.
if ! git pull -q --rebase; then
  git rebase --abort
  echo "CONFLICT: rebase aborted, nothing pushed. Resolve ~/dotfiles by hand." >&2
  exit 1
fi

git push -q || { echo "push failed" >&2; exit 1; }
echo "synced"
