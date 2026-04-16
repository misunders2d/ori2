# Install ori2

## Prerequisites

- **Node.js v18+** (`node -v`)
- **git**
- **build tools** for native modules (Linux: `build-essential`, `python3`; macOS: Xcode CLT) — needed by `better-sqlite3` first install
- ~250MB free disk for embeddings + node_modules
- Outbound HTTPS to your chosen LLM provider (Anthropic / Google / OpenAI) and to any chat platforms you connect (Telegram / Slack / etc.)

## Quick install (one-liner)

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/<YOUR_FORK>/ori2/master/bootstrap.sh)" -- --name MyBot
```

The bootstrap will:
1. Verify Node ≥ 18, git, npm
2. Clone the repo (or pull if present)
3. Run `npm install`
4. Run `npm test` — halts the install if any baseline test fails. To override (NOT recommended), `export ORI2_SKIP_TESTS=1` before re-running.
5. Launch the first-run wizard (asks for bot name, optional admin IDs, primary AI provider key)
6. Optionally install a systemd user unit (Linux) or launchd LaunchAgent (macOS) for headless deployment

## Manual install

```bash
git clone https://github.com/<YOUR_FORK>/ori2.git
cd ori2
npm install
npm run start
```

The first start triggers the wizard. After setup, the bot launches in interactive TUI mode (if your terminal is attached) or daemon mode (if not).

## Modes

| Mode        | Trigger                                          | Behavior                                                      |
|-------------|--------------------------------------------------|---------------------------------------------------------------|
| Interactive | `process.stdout.isTTY === true`, OR `ORI2_DAEMON=false` | Launches Pi's TUI, agent driven by terminal input. Network adapters work in parallel. |
| Daemon      | No TTY (systemd, docker, detached SSH), OR `ORI2_DAEMON=true` | No TUI. Loads extensions + adapters. Inbound from Telegram/Slack/etc. drives the agent. Blocks on SIGTERM/SIGINT/SIGHUP. |

## Headless deployment (Linux, systemd user mode)

The bootstrap can install a systemd user unit. Manual setup:

```bash
mkdir -p ~/.config/systemd/user
mkdir -p "$PWD/data/MyBot/.pi-state"

NPM_PATH="$(command -v npm)"
PATH_ENV="$(dirname "$NPM_PATH"):/usr/local/bin:/usr/bin:/bin"

# Render the template
sed -e "s|@INSTALL_DIR@|$PWD|g" \
    -e "s|@BOT_NAME@|MyBot|g" \
    -e "s|@USER@|$USER|g" \
    -e "s|@NPM_PATH@|$NPM_PATH|g" \
    -e "s|@PATH@|$PATH_ENV|g" \
    systemd/ori2.service > ~/.config/systemd/user/ori2-MyBot.service

systemctl --user daemon-reload
systemctl --user enable --now ori2-MyBot

# Survive logout
sudo loginctl enable-linger $USER

# Logs
journalctl --user -u ori2-MyBot -f
```

To restart after a code update:
```bash
cd /path/to/ori2 && git pull && npm install
systemctl --user restart ori2-MyBot
```

## Headless deployment (macOS, launchd)

The bootstrap installer auto-renders and loads the plist if you accept the
prompt. To do it manually from a checkout:

```bash
NPM_PATH="$(command -v npm)"
PATH_ENV="$(dirname "$NPM_PATH"):/usr/local/bin:/usr/bin:/bin"

sed -e "s|@INSTALL_DIR@|$PWD|g" \
    -e "s|@BOT_NAME@|MyBot|g" \
    -e "s|@USER@|$USER|g" \
    -e "s|@NPM_PATH@|$NPM_PATH|g" \
    -e "s|@PATH@|$PATH_ENV|g" \
    launchd/dev.ori2.plist.template \
  > ~/Library/LaunchAgents/dev.ori2.MyBot.plist

launchctl load   ~/Library/LaunchAgents/dev.ori2.MyBot.plist
launchctl start  dev.ori2.MyBot
tail -f /tmp/ori2-MyBot.log
```

Restart after a code update:
```bash
cd /path/to/ori2 && git pull && npm install
launchctl kickstart -k gui/$(id -u)/dev.ori2.MyBot
```

Uninstall:
```bash
launchctl unload ~/Library/LaunchAgents/dev.ori2.MyBot.plist
rm ~/Library/LaunchAgents/dev.ori2.MyBot.plist
```

## Headless deployment (Docker)

A `Dockerfile` is not bundled with baseline ori2 — your deployment likely needs custom layers (your credentials, your tools, your evolved extensions). Reference Dockerfile to start from:

```dockerfile
FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
        git python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV ORI2_DAEMON=true
CMD ["npm", "run", "start"]
```

Mount `data/` as a volume to persist sessions/vault/memory.

## Running multiple bots on one host

Each bot lives in its own checkout. The two checkouts are fully independent:

| Resource | Per-bot | Where |
|---|---|---|
| Vault, memory, sessions, plans, OAuth, credentials, channel log | ✅ | `<checkout>/data/<BOT>/` |
| Fastembed model cache (~130MB) | ✅ | `<checkout>/data/<BOT>/.fastembed_cache/` |
| Pi SDK global config (auth/models/settings/themes/debug log) | ✅ | `<checkout>/data/<BOT>/.pi-state/` (via `PI_CODING_AGENT_DIR`) |
| Instance lock | ✅ | `<checkout>/data/<BOT>/.instance.lock` (PID-checked, stale-tolerant) |
| systemd unit / launchd label | ✅ | `ori2-<BOT>.service` / `dev.ori2.<BOT>` |
| Telegram bot token | ✅ | each bot's vault — different bot accounts |
| `.env`, `.pi/extensions/`, `node_modules/` | ✅ (separate checkout) | each checkout's own |

No port collisions: Telegram is long-poll, OAuth uses Device Code (no callback). Two bots talking to two different Telegram bots can run side-by-side under one OS user with zero shared mutable state.

`PI_CODING_AGENT_DIR` is the only piece of isolation you need to know about: without it, every bot run by the same OS user would share `~/.pi/agent/` (Pi SDK's default) and concurrent writes to `auth.json` / `settings.json` would race. The bootstrap, the systemd template, the launchd template, and `npm start` all set this per-bot.

## After install — claiming admin

The first boot prints a one-time admin claim passcode in the boot log:

```
🔑 Admin claim passcode (ONE-TIME, save it if using remotely):
   893c090006efff32

   From any configured chat platform (Telegram/Slack/…) send:
     /init 893c090006efff32
   to promote yourself to admin.
```

Open your bot in Telegram (or whichever chat platform you've configured), send `/init <passcode>`, and you're admin. The passcode is consumed on first successful claim.

If you missed it, run `/init-status` from the terminal to re-display.

## Connecting Telegram (post-install)

```
/connect-telegram <bot_token_from_BotFather>
```

The bot validates the token via `getMe`, stores it in the vault, restarts the Telegram adapter. After that, DM your bot — your message will be blocked until you `/init <passcode>` from chat (which whitelists your Telegram identity automatically).

## Connecting other services

OAuth (Google, GitHub, Microsoft, Slack-OAuth, custom providers):
```
/oauth help
```

Personal Access Tokens (GitHub PATs, ClickUp, Stripe, SendGrid, etc.):
```
/credentials help
```

## Memory / scheduling / plans

- `/memory help` — long-term semantic memory
- `/schedule` — list scheduled tasks
- `/plans` — list active plans (interactive + scheduled)

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `better-sqlite3` install fails | Missing build tools | Linux: `apt install build-essential python3`. macOS: install Xcode CLT |
| Daemon mode in TTY | `ORI2_DAEMON=true` set somewhere | Unset it or pass `ORI2_DAEMON=false` |
| Telegram blocks every message | Sender not in whitelist | `/init <passcode>` from Telegram (auto-whitelist), or `/whitelist add telegram <id>` from CLI |
| Guardrail says OFFLINE | Corpus file missing | Reinstall — `.pi/extensions/guardrail_corpus.json` should exist in repo |
| `/oauth connect google` says NOT REGISTERED | Operator hasn't created Google Cloud OAuth app | See `/oauth help` for the 3-step Google project setup |

## Updating

```bash
cd /path/to/ori2
git pull
npm install                 # if package.json changed
systemctl --user restart ori2-MyBot   # if running under systemd
# OR
launchctl kickstart -k gui/$(id -u)/dev.ori2.MyBot   # macOS
```
