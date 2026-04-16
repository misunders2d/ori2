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
4. Launch the first-run wizard (asks for bot name, optional admin IDs, primary AI provider key)
5. Optionally install a systemd user unit for headless deployment

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

# Render the template
sed -e 's|@INSTALL_DIR@|'"$PWD"'|g' \
    -e 's|@BOT_NAME@|MyBot|g' \
    -e 's|@USER@|'"$USER"'|g' \
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

Create `~/Library/LaunchAgents/dev.ori2.MyBot.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>dev.ori2.MyBot</string>
    <key>WorkingDirectory</key><string>/path/to/ori2</string>
    <key>ProgramArguments</key>
    <array><string>/usr/bin/env</string><string>npm</string><string>run</string><string>start</string></array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>ORI2_DAEMON</key><string>true</string>
        <key>BOT_NAME</key><string>MyBot</string>
        <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>Crashed</key><true/></dict>
    <key>StandardOutPath</key><string>/tmp/ori2-MyBot.log</string>
    <key>StandardErrorPath</key><string>/tmp/ori2-MyBot.log</string>
</dict>
</plist>
```

Then:
```bash
launchctl load ~/Library/LaunchAgents/dev.ori2.MyBot.plist
launchctl start dev.ori2.MyBot
tail -f /tmp/ori2-MyBot.log
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
