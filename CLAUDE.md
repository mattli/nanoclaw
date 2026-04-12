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

## Telegram Bot Privacy Mode (for `requiresTrigger: false` groups)

Telegram bots have a **Group Privacy** setting in BotFather that's on by default. With it on, bots in group chats only see: commands (starting with `/`), messages @mentioning the bot, and replies to the bot's own messages. Everything else is hidden from the bot at the Telegram layer, before NanoClaw ever sees it.

**This means:** for any Telegram group registered with `requiresTrigger: false`, the application-layer flag alone is insufficient. Group Privacy must also be **disabled** in BotFather for the bot, otherwise plain messages never reach NanoClaw and the group appears non-responsive. DMs are unaffected (privacy mode doesn't apply to 1:1 chats), which is why a main-channel DM works without any BotFather change.

**To disable:** BotFather → `/mybots` → select bot → Bot Settings → Group Privacy → Turn off.

Privacy mode is per-bot and global across all groups that bot is a member of. Turning it off on the main bot doesn't change behavior in other `requiresTrigger: true` groups — those still enforce the trigger at the application layer (`src/index.ts:173`).

## Credential Proxy Pattern

Never pass third-party API keys directly into containers via environment variables. All secrets must go through the credential proxy (`src/credential-proxy.ts`). The proxy reads keys from `.env` on the host and injects auth headers on outbound requests — containers never see real credentials. When adding a new external service, add a proxy route (like `/parallel-search/`) and have the container hit the proxy URL instead.

## Launchd PATH

The launchd environment has a minimal PATH (`/usr/local/bin:/usr/bin:/bin`). Skill handlers that spawn subprocesses needing Homebrew binaries (Node, Python packages, etc.) must augment PATH with `/opt/homebrew/bin`. See `src/skill-handlers/last30days.ts` for the pattern.

**Launchd also does not populate `process.env` with secrets.** The plist exports only `PATH` and `HOME` — all other env-configured secrets (including `TELEGRAM_BOT_TOKEN`, `GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, etc.) are read from the `.env` file at runtime via `readEnvFile` / `readEnvFilePrefix` in `src/env.ts`. Any new code that introduces env-var scanning must read both sources: `process.env` for dev (`npm run dev` inherits the shell env) and the `.env` file for production (launchd). A pure `process.env` scan will work in dev and silently fail under launchd. Use `readEnvFilePrefix(prefix)` for prefix scans — it's the blessed pattern for prefix-based env reads.

## Agent Runner Session Copies

On first spawn, each group gets a copy of `container/agent-runner/src/` at `data/sessions/<group>/agent-runner-src/`. This copy is NOT updated automatically. After changing the canonical agent-runner source, delete the stale session copies so they get recreated on next spawn.

## Commit Before Ending a Session

Any changes to `src/` must be committed before the session ends. `npm run build` compiles `src/` → `dist/`, but `dist/` is ephemeral — the next `npm run build` from any session will overwrite it from whatever is in `src/`. If source changes aren't committed, a later session running build, prettier, or git checkout will silently erase them. This has caused a production regression before (thread search handler lost for a week).

## Container Build Cache

The container buildkit caches the build context aggressively. `build.sh` handles this automatically — it prunes the builder and rebuilds with `--no-cache` every time.

