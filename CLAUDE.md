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
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript (does NOT restart NanoClaw)
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

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Telegram Bot Privacy Mode (for `requiresTrigger: false` groups)

Telegram bots have a **Group Privacy** setting in BotFather that's on by default. With it on, bots in group chats only see: commands (starting with `/`), messages @mentioning the bot, and replies to the bot's own messages. Everything else is hidden from the bot at the Telegram layer, before NanoClaw ever sees it.

**This means:** for any Telegram group registered with `requiresTrigger: false`, the application-layer flag alone is insufficient. Group Privacy must also be **disabled** in BotFather for the bot, otherwise plain messages never reach NanoClaw and the group appears non-responsive. DMs are unaffected (privacy mode doesn't apply to 1:1 chats), which is why a main-channel DM works without any BotFather change.

**To disable:** BotFather → `/mybots` → select bot → Bot Settings → Group Privacy → Turn off.

Privacy mode is per-bot and global across all groups that bot is a member of. Turning it off on the main bot doesn't change behavior in other `requiresTrigger: true` groups — those still enforce the trigger at the application layer (`src/index.ts:173`).

## Credential Proxy Pattern

Never pass third-party API keys directly into containers via environment variables. All secrets must go through the credential proxy (`src/credential-proxy.ts`). The proxy reads keys from `.env` on the host and injects auth headers on outbound requests — containers never see real credentials. When adding a new external service, add a proxy route (like `/parallel-search/`) and have the container hit the proxy URL instead.

The proxy has two transient-failure mitigations on the Anthropic upstream path: (1) public-DNS resolver + 5-min cache + last-known-good fallback (defends against Tailscale MagicDNS drops); (2) retry on 502/503/504/529 and connection errors (ECONNRESET, etc.), bounded by an attempt cap (8) **and** a 180s wall-clock deadline, exponential backoff with full jitter, honors `Retry-After`, streaming-safe (only retries before any bytes are piped downstream). Budget was sized after a ~7-min Anthropic edge outage on 2026-04-27 killed every wiki compiler run with a 2-attempt budget. The dual cap (attempts + deadline) prevents both wedging on slow backoff and unbounded stacking with the Claude CLI's own internal retries. If you add a new proxy route that talks to a flaky upstream, decide explicitly whether to copy this pattern; the Parallel AI route currently doesn't have it.

**Second-line defense at the scheduler.** When the proxy budget is exhausted, the SDK surfaces `API Error: 5xx` to the agent-runner, which propagates as a task error. `src/task-scheduler.ts` watches for transient API errors (`/API Error: 5\d\d|ECONNRESET|socket hang up|ETIMEDOUT|EAI_AGAIN/i`) and reschedules the same task for `Date.now() + 5min`, max 2 retries (in-memory `transientRetryCount` map, resets on success or process restart). For `once`-type tasks, this overrides the `null` next_run that would normally mark them completed. Combined coverage: sub-13-min Anthropic incidents are absorbed transparently; longer ones fail visibly and the next cron picks up cleanly.

## Launchd PATH

The launchd environment has a minimal PATH (`/usr/local/bin:/usr/bin:/bin`). Skill handlers that spawn subprocesses needing Homebrew binaries (Node, Python packages, etc.) must augment PATH with `/opt/homebrew/bin`. See `src/skill-handlers/last30days.ts` for the pattern.

**Launchd also does not populate `process.env` with secrets.** The plist exports only `PATH` and `HOME` — all other env-configured secrets (including `TELEGRAM_BOT_TOKEN`, `GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, etc.) are read from the `.env` file at runtime via `readEnvFile` / `readEnvFilePrefix` in `src/env.ts`. Any new code that introduces env-var scanning must read both sources: `process.env` for dev (`npm run dev` inherits the shell env) and the `.env` file for production (launchd). A pure `process.env` scan will work in dev and silently fail under launchd. Use `readEnvFilePrefix(prefix)` for prefix scans — it's the blessed pattern for prefix-based env reads.

## Channel Import Barrel

`src/channels/index.ts` is a barrel file where each channel must be explicitly imported. Upstream keeps this file empty (channels are fork repos for them). After any upstream merge, verify that `import './telegram.js'` is present — without it, NanoClaw crashes on startup with "No channels connected".

## Agent Runner Session Copies

On first spawn, each group gets a copy of `container/agent-runner/src/` at `data/sessions/<group>/agent-runner-src/`. This copy is NOT updated automatically. After changing the canonical agent-runner source, delete the stale session copies so they get recreated on next spawn.

## Commit Before Ending a Session

Any changes to `src/` must be committed before the session ends. `npm run build` compiles `src/` → `dist/`, but `dist/` is ephemeral — the next `npm run build` from any session will overwrite it from whatever is in `src/`. If source changes aren't committed, a later session running build, prettier, or git checkout will silently erase them. This has caused a production regression before (thread search handler lost for a week).

## Container Build Cache

The container buildkit caches the build context aggressively. `build.sh` handles this automatically — it prunes the builder and rebuilds with `--no-cache` every time.

