# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript + restart NanoClaw
npm run typecheck    # Type-check only (no build or restart)
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Credential Proxy Pattern

Never pass third-party API keys directly into containers via environment variables. All secrets must go through the credential proxy (`src/credential-proxy.ts`). The proxy reads keys from `.env` on the host and injects auth headers on outbound requests — containers never see real credentials. When adding a new external service, add a proxy route (like `/parallel-search/`) and have the container hit the proxy URL instead.

## Launchd PATH

The launchd environment has a minimal PATH (`/usr/local/bin:/usr/bin:/bin`). Skill handlers that spawn subprocesses needing Homebrew binaries (Node, Python packages, etc.) must augment PATH with `/opt/homebrew/bin`. See `src/skill-handlers/last30days.ts` for the pattern.

## Agent Runner Session Copies

On first spawn, each group gets a copy of `container/agent-runner/src/` at `data/sessions/<group>/agent-runner-src/`. This copy is NOT updated automatically. After changing the canonical agent-runner source, delete the stale session copies so they get recreated on next spawn.

## Commit Before Ending a Session

Any changes to `src/` must be committed before the session ends. `npm run build` compiles `src/` → `dist/`, but `dist/` is ephemeral — the next `npm run build` from any session will overwrite it from whatever is in `src/`. If source changes aren't committed, a later session running build, prettier, or git checkout will silently erase them. This has caused a production regression before (thread search handler lost for a week).

## Container Build Cache

The container buildkit caches the build context aggressively. `build.sh` handles this automatically — it prunes the builder and rebuilds with `--no-cache` every time.

