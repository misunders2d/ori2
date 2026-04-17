# 🧬 Ori2: The Self-Evolving Digital Organism (TypeScript edition)

**Ori2** is not just a background process — it is a headless, messenger-agnostic autonomous worker built to grow, learn, and evolve. Think of it as a **digital pet for operators**. It lives on your VPS, handles your chores, and — most importantly — **it writes its own DNA.** It chats with peers over the Google A2A protocol, shares verified evolutions between instances, and rolls itself back the moment a new feature breaks its tests.

Ori2 is a **platform** — a minimal, evolvable foundation built on the [Pi SDK](https://github.com/badlogic/pi-mono). Deploy it once, raise it your way, and watch it grow into whatever you need: Amazon manager, marketing analyst, inventory tracker, chat admin, or something nobody's thought of yet.

> Sibling project: the original Python/ADK [Ori](https://github.com/misunders2d/ori). Ori2 is a ground-up TypeScript rebuild on the Pi SDK, keeping the organism metaphor and the evolution ambition while dropping Docker-for-parent, LanceDB, and Google ADK in favour of local-first tooling.

## 🎮 The Evolution Experience

Ori2 is designed to be raised. Out of the box she is a capable assistant; her true form is determined by how you chat with her and which skills you let her develop.

*   **Evolutionary Engineering:** Describe a new capability in natural language. Ori2 writes the extension with Pi's built-in `write` tool, runs the tests, and — with your one-tap approval — `/reload`s into her live brain.
*   **DNA Exchange Between Bots:** Feature-grain sharing over A2A. Register a proven extension + skill as a DNA feature, mark it public, and any friend bot can `/dna pull AmazonBot clickup-integration`, stage it, run tests, snapshot + apply. Test fails → auto-rollback from snapshot. Her immune system protects both sides.
*   **Friend Network:** Ori2 speaks the official [Google A2A protocol](https://github.com/a2aproject/a2a-spec). Two operators swap a single invitation token and their bots now chat peer-to-peer with asymmetric per-friend bearer keys. No central authority.
*   **Living Skills:** The `.pi/skills/` directory is how Ori2 teaches herself new behaviours — read by the agent like a cookbook. She can write and rewrite her own.
*   **Trust & Training:** Every admin decision is recorded. Sharp admin/user split enforced from the first second the bot boots.
*   **Multi-Provider Brain:** Anthropic Claude, Google Gemini, OpenAI. Hot-swap at runtime via the Pi SDK.

## 🧠 Anatomy of an Autonomous Being

*   **The Brain (Headless Core):** TypeScript on the Pi SDK. Runs natively via `tsx` — no Docker cage for the parent. Auto-detects terminal vs. daemon mode; systemd (Linux) or launchd (macOS) manages restarts.
*   **The Immune System (Zero-Trust Guardrails):**
    *   **Semantic Defense:** Every user input embedded by a local `fastembed` model (`BGE-small-en-v1.5`) and checked against a 45-attack-anchor corpus. Prompt-injection attempts are caught before they reach the LLM.
    *   **Output Interception:** Web/bash/read tool results are re-checked — data from the wild can't catch a virus into her own context.
    *   **Fail-Loud:** If the guardrail itself can't run, the message is refused. Never silently passes.
*   **The Vault (Indestructible Memory):** Secrets live at `data/<bot>/vault.json` — atomic writes (tmp + fsync + rename), mode 0600, fail-loud on corruption. Git-ignored. Compromising a checkout's filesystem does not reveal authentication material kept in vault.
*   **Long-Term Recall (Neural Lattice):** `better-sqlite3` + `sqlite-vec` for KNN, same BGE-small embedder. Semantic recall across restarts — ask "where does the user live?" and "Vienna" comes back even if you never said that exact phrase. Tools: `memory_save`, `memory_search`, `memory_list_tags`.
*   **Working Memory (auto-managed):** Conversation context compaction is handled by the Pi SDK — old turns get summarized into a structured block when you get close to the window, recent turns stay verbatim. Configure via `~/.pi/agent/settings.json` or per-bot `<data>/.pi-state/settings.json`.
*   **Nervous System (Rich Media):** Telegram adapter supports photos, documents, audio, voice, video. Ori2 receives PDFs/CSVs as parsed text, images as image content for multi-modal models.
*   **Metabolism (Scheduler):** `node-schedule` cron with per-fire **fresh sessions**. Each scheduled run spawns a subprocess with its own session id, optional pre-seeded plan, and a report-back channel. The live session stays uncontaminated.
*   **Self-Awareness (Observability):** Ori can ask herself "am I OK?" mid-turn. `health_report`, `read_error_ledger`, `read_channel_log`, `check_telegram_connection`, `check_friend_reachability` are LLM-callable tools she invokes on request. Telegram poller + cloudflared tunnel write liveness heartbeats; the error ledger captures every internal warning/failure as structured JSONL. A background check every 30 minutes DMs the admin via Telegram when status drifts — no manual polling required.

## 🏗️ Architecture

```
npm start
  └── src/index.ts (bootstrap)
       ├── vault load + hydrate env
       ├── instance lock (PID-checked, stale-tolerant)
       ├── TransportDispatcher
       │    ├── CliAdapter        (terminal, implicit admin, sentinel-protected)
       │    ├── TelegramAdapter   (long-poll, Bot API)
       │    └── A2AAdapter        (peer-to-peer, Cloudflare Tunnel)
       ├── A2A server + tunnel manager (non-fatal; rest of bot survives outage)
       ├── init passcode (one-time admin claim)
       └── Daemon mode (no TTY) OR Pi TUI (interactive)

.pi/extensions/ — the organ system (17 files)
    admin_gate • audit_and_limits • credentials • diagnostics • dna
    evolve • guardrails • memory • npm_security • oauth • persona
    plan_enforcer • scheduler • tdd_enforcer • transport_bridge
    web_tools • a2a
```

## ⚡ Quick Hatch (One-Liner)

**Linux / macOS:**
```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/misunders2d/ori2/master/bootstrap.sh)" -- --name MyBot
```

Clones, installs, runs the baseline test gate, walks you through the setup wizard, optionally registers as systemd (Linux) / launchd (macOS).

**Already hatched?**
```bash
npm start                                      # start in interactive mode
systemctl --user start  ori2-MyBot             # start as service (Linux)
launchctl kickstart gui/$UID/dev.ori2.MyBot    # start as service (macOS)
```

Full deployment reference: [INSTALL.md](INSTALL.md).

## 🛡️ Action Approval Protocol & Security

To keep her body safe from her own bad days, privileged actions are wrapped in a staging layer.

1.  **Per-Tool Policy Engine:** Every tool call is evaluated against `data/<bot>/tool_acl.json` — deny-precedence rules with args-aware matching (dot-paths + safe glob, no ReDoS surface).
2.  **Staging (The Token):** A gated call produces a single-use token (`ACT-8A4F9X`). The action is not executed until the admin replies `Approve ACT-8A4F9X` in the same thread.
3.  **TOTP 2FA:** Admins `/totp setup` once (QR in chat), then add `require_2fa` to any rule. Staged approvals on those rules demand a 6-digit code: `Approve ACT-8A4F9X 123456`.
4.  **Role-Based ACL:** Users hold named roles (`admin`, `user` implicit; `marketing-team`, `company-users` free-form). Tools specify required roles. `admin` is superuser.
5.  **Credential Capture:** When the admin pastes a token in chat, the dispatcher's pre-hook intercepts it **before the LLM sees it**. The message is deleted from context; only the vault keeps the secret.
6.  **Guardrails First:** Prompt-injection attempts are blocked before admin gate and before staging. Even admins can't "jailbreak" their own bot through external input.

Staged tokens expire after 15 minutes. 139 tests cover this security surface.

## 🌐 The Ori-Net Bridge

Your Ori2 is no longer an island. With the **Agent-to-Agent (A2A) Protocol**, your bot can discover, trust, and collaborate with other autonomous beings across the internet.

*   **Real A2A-Spec Compliance:** `.well-known/agent.json` discovery, JSON-RPC `message/send` / `tasks/get` / `tasks/cancel`, bearer-key auth. Any A2A-spec agent (not just other Ori2s) can be registered as a friend.
*   **Bilateral Trust:** Operators exchange a single invitation token. No central authority, no PKI. Either side revokes unilaterally by removing the friend.
*   **Asymmetric Per-Friend Keys:** Each friendship holds TWO keys — her inbound key (what they use to call her) + her outbound key (what she uses to call them). A friend-list leak reveals no authentication material; keys live in the vault.
*   **Zero-Config Internet Tunnel:** A managed `cloudflared` child gets her a free `*.trycloudflare.com` URL on every boot. When the URL rotates, she broadcasts the new one to every friend automatically.
*   **DNA Exchange at Feature Grain:** Declare a named feature (files in `.pi/extensions/` + `.pi/skills/`). It appears as a `dna:<id>` skill on the agent card. Friends `/dna pull` it; the secret scanner refuses any file with a detected credential (regex + entropy + hard-refused filenames like `.env`, `vault.json`, `*.pem`). Every apply takes a snapshot; test failure auto-restores.
*   **Privacy Guardrail:** Outbound DNA packages are re-scanned at the source on every pull (even if registered earlier), and the importer re-scans on arrival — trust, but verify.

## 🩺 Self-Diagnosis (Observability)

Ori knows how she's doing and tells you when something drifts — you shouldn't have to SSH in to find out.

*   **LLM-callable health tools.** Ask her in plain chat: *"how are you?"* or *"check your Telegram connection"* or *"any errors recently?"*. She has real tools for each — `health_report({deep?})`, `read_error_ledger`, `read_channel_log`, `read_scheduler_jobs`, `check_telegram_connection`, `check_friend_reachability`, `inspect_env`. Each is also a slash command (`/health`, `/health deep`, `/health errors [N]`, `/health probe telegram`, `/health probe friends`).
*   **Unified status report.** `/health` rolls up: adapter state + heartbeats, vault + memory + plans + scheduler + rate limits + OAuth + channel log + disk + guardrails + A2A + error counts. Status = `healthy` | `degraded` | `unhealthy`, with a concrete warnings list. Use `deep` for live probes (Telegram `getMe`, A2A friend `/health` pings, disk walk).
*   **Subsystem heartbeats.** The Telegram poller writes one after every `getUpdates`; the cloudflared tunnel writes one on URL-ready + every 30s while alive. Stale >60s flags the subsystem as degraded. You learn about a wedged long-poll before the user does.
*   **Structured error ledger.** Every internal warning/error (Telegram 401, cloudflared crash, scheduler exception, guardrail init failure, bootstrap issues) lands in `data/<bot>/errors.jsonl` — queryable, filterable, auto-rotating. `console.error` still mirrors to stdout so `journalctl` / `launchctl log` stays informative.
*   **Proactive DM, not silent failure.** 10 seconds after boot and every 30 minutes thereafter, Ori runs her own deep health check. If status drifts from healthy AND the warning set *changed* since last check, she DMs every admin in `ADMIN_USER_IDS` via their preferred adapter. She never spams the same warning twice; recovery gets an info-level ledger entry. Opt out with `PROACTIVE_DIAGNOSTICS=false` in vault.

## ⚡ Feature Showcase (Ability Tree)

*   **[SYSTEM PERK] Tactical Silence:** Interrupt her mid-thought. Pi's TUI surfaces `/abort` to stop off-track reasoning instantly and save tokens.
*   **[SYSTEM PERK] Autonomous Self-Refinement:** Ori writes a new extension to `.pi/extensions/` via Pi's built-in `write` tool. Tell her "reload" → the organ is alive.
*   **[SYSTEM PERK] Snapshot-and-Rollback Evolution:** Every DNA apply auto-snapshots `.pi/`. `npm test` fails → the new organ is excised and she reverts to the last healthy body.
*   **[SYSTEM PERK] The Chronos Scheduler:** Recurring cron jobs, reminders, one-shot firings. Per-fire fresh sessions — a scheduled autonomous run can't corrupt the interactive session.
*   **[SYSTEM PERK] Per-Fire Plan Enforcement:** Scheduled autonomous runs execute a pre-defined `steps[]` plan with no ability to self-cancel. Admin override from chat or A2A peer.
*   **[SYSTEM PERK] Neural Lattice Memory:** Long-term recall powered by `sqlite-vec` + local embeddings. Survives reboots; no cloud call required.
*   **[SYSTEM PERK] Context Compaction:** Pi's built-in summariser keeps the conversation window healthy without losing the thread — old turns become a structured Goal/Progress/Decisions summary; recent turns stay verbatim.
*   **[SYSTEM PERK] Headless-First OAuth:** Google / GitHub / Microsoft / Slack via Device Code flow. No callback URL, no desktop browser needed on the VPS. Auth Code + PKCE with paste-back as a fallback.
*   **[SYSTEM PERK] Hot-Swap Models:** Anthropic / Google / OpenAI. Pi's `pi.setModel` flips providers per-session at runtime.
*   **[SYSTEM PERK] Self-Diagnosis + Admin Alerts:** Ori runs her own health probe every 30 minutes and DMs the admin when something drifts. `/health` and a full suite of LLM-callable observability tools let her answer *"am I OK?"* mid-turn without you having to ask.

## 📋 Prerequisites

- **Node.js v22+** (LTS)
- **git**
- **build tools** for native modules — Linux: `build-essential` + `python3`; macOS: Xcode CLT
- **~250MB disk** for `node_modules` + embedding model cache
- **cloudflared** (optional) — only if you want A2A's automatic public URL

## 🛠 Manual Installation

### 1. Claiming an Egg

You **do not need to fork on GitHub first**. The one-liner installer (above) clones the canonical repo, then immediately detaches — wipes `.git`, starts a fresh commit history, drops a `.ori2-baseline` marker so future upstream-sync calls know where she hatched from. From that moment on, your bot's code belongs to *you*, not to the upstream repo. Evolution lives on your own timeline with zero risk of any self-evolution writing to someone else's GitHub.

When you're ready to publish your evolved bot somewhere — your own private repo, a team-shared repo, a public fork:

```bash
git remote add origin git@github.com:YOU/YOUR-BOT.git
git push -u origin master
```

**If you're the upstream maintainer** (rare) and want the one-liner to preserve the upstream remote, pass `--keep-upstream`.

### 2. Manual Incubation (if you prefer)

```bash
git clone https://github.com/misunders2d/ori2.git MyBot
cd MyBot
# Manual detach (if you also want a fresh history):
rm -rf .git && git init && git add -A && git commit -m "Initial snapshot"
npm install
npm start
```

On first run, the **setup wizard** walks you through:

1. **Bot name** — becomes the `data/<BOT_NAME>/` namespace on disk
2. **LLM provider (required)** — Anthropic Claude, Google Gemini, or OpenAI (API key)
3. **Admin bootstrap (optional)** — pre-fill `ADMIN_USER_IDS` so a specific Telegram/Slack user is already admin on first contact. You can skip this and use the `/init <passcode>` flow instead.
4. **Telegram (optional)** — paste a bot token from @BotFather to enable remote chat; skip to use CLI-only.

### 3. First Contact

If no messenger is configured, Ori2 launches in **interactive TUI mode** in your terminal — the Pi SDK's chat interface. She'll walk you through claiming admin + connecting Telegram.

If Telegram is configured, watch the boot log for the **admin passcode**:

```
🔑 Admin claim passcode (ONE-TIME, save it if using remotely):
   893c090006efff32
```

Send `/init 893c090006efff32` from Telegram. You're now admin; the passcode is consumed.

## ⚙️ Configuration

All secrets and platform config live in the **vault** (`data/<BOT_NAME>/vault.json`). Plain `.env` is runtime-only — bot name, provider choice, no secrets. The wizard wires both for you on first run; after that use `/vault` and per-subsystem slash commands.

Commonly-touched keys:

| Key | Purpose |
|---|---|
| `ADMIN_USER_IDS` | Comma-separated bootstrap admins, format `platform:senderId` or bare senderId |
| `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` / `OPENAI_API_KEY` | LLM provider credentials |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token — set via `/connect-telegram` |
| `AGENT_RPM` | Rate limit per user per minute (default 30; CLI + admins exempt) |
| `A2A_TUNNEL_MODE` | `cloudflared` (default) / `external` / `disabled` |
| `A2A_BIND_PORT` | Sticky local bind (default 8085, auto-walks on conflict) |
| `GUARDRAIL_EMBEDDINGS` | `local` (default, fastembed) / `google` / `openai` |
| `PROACTIVE_DIAGNOSTICS` | `true` (default) / `false` — disables the periodic self-health-check + admin-DM |
| `PROACTIVE_DIAGNOSTICS_INTERVAL_MIN` | `30` (default) — how often the background health check runs |

Everything else is discoverable through slash commands: `/whitelist`, `/role`, `/tool-acl`, `/staging`, `/totp`, `/memory`, `/schedule`, `/plans`, `/credentials`, `/oauth`, `/transports`, `/a2a`, `/dna`, `/log`, `/limits`, `/evolve`, `/health`.

## 🧬 Evolving Your Bot

The agent can write her own organs while running.

```
You: "I want a ClickUp integration. Tasks: list, create, comment. Store the API token in credentials, build the extension, add a skill."

Ori2:  Researches ClickUp API.
       Stages /credentials add (intercepted pre-LLM — your token never
       enters context).
       write(path=.pi/extensions/clickup.ts, content=<TS code>)
       write(path=.pi/skills/clickup-usage/SKILL.md, content=<markdown>)
       "Extension written. Run /reload to enable."

You: /reload
     → new tools appear in this session
```

### How to add a new capability

Ori2 is organised around **two primitives** that together act like a sub-agent in frameworks like Google ADK or LangChain:

*   **An extension** (`.pi/extensions/<domain>.ts`) — one TypeScript file per domain. Registers tools (LLM-callable functions), slash commands, and hooks. Example: `amazon.ts` → `amazon_list_orders`, `amazon_get_listing`, `amazon_update_price`.
*   **A skill** (`.pi/skills/<domain>-ops/SKILL.md`) — structured markdown the agent reads *lazily* when relevant. Tells her when to use which tool, required data, common pitfalls. Example: `amazon-ops/SKILL.md` → "Before updating a price, always pull current inventory and Keepa history first."

**Extension + skill ≈ sub-agent.** Same practical effect as ADK's sub-agent pattern without the multi-agent coordination tax. One bot, many specialisations.

Just ask her in chat — *"how do I add an Amazon SP-API integration?"* — and she'll walk you through it. She's equipped with a dedicated skill (`adding-capabilities`) that explains the mental model, and the rigid 6-phase SOP (`evolution-sop`) for anything non-trivial: threat modelling → doc research → secure dependency audit → scaffolding → TDD → verify + commit. She writes both files for you using Pi's built-in `write` tool; `/reload` makes them live in the current session.

**Scaling pattern, in order:** one instance with multiple extensions → mode switching inside one instance when the tool list bloats → separate Ori2 instances per role communicating over A2A when teams need independent evolution paths.

Operator-facing surface: `/evolve list`, `/evolve diff`, `/evolve help`. For sharing proven evolutions between bots, see `/dna` (DNA exchange).

For non-trivial features, prefer the DNA + snapshot path:

```
/dna feature add clickup-integration \
    .pi/extensions/clickup.ts .pi/skills/clickup-usage/SKILL.md \
    --description "ClickUp tasks, verified 30 days" --tags integration,crm

# Share it with your friend bot:
# on their side:
/dna pull AmazonBot clickup-integration
/dna apply <import-id>    # snapshots .pi/ → copies files → runs npm test
                          # test fails → automatic rollback
```

Full reference via `/evolve help`, `/dna help`, and the `evolution-sop` skill Ori2 ships with.

## 🏃 Running Multiple Bots on One Host

Each bot lives in its own checkout. Zero shared mutable state:

- `data/<BOT>/` holds vault, memory, sessions, plans, OAuth, credentials, channel log, fastembed cache, Pi SDK per-bot state (`PI_CODING_AGENT_DIR=.pi-state/`)
- A2A port auto-walks on conflict
- Telegram is long-poll (no port binding)
- OAuth is Device Code (no callback)

Two bots with different Telegram tokens can run side-by-side under one OS user under systemd/launchd — no interference. See INSTALL.md for multi-instance systemd/launchd examples.

## 🔄 Pulling Upstream Baseline Updates (optional)

Because your bot is detached, `git pull` doesn't grab upstream changes. That's the point — your evolutions can't be clobbered by a background sync. To see what's new upstream when you want to:

```bash
./scripts/sync-baseline.sh             # prints log + diff since your baseline, drops the remote
./scripts/sync-baseline.sh --remote    # keeps the remote so you can merge/cherry-pick
./scripts/sync-baseline.sh --mark <sha>  # update the baseline marker after a merge
```

The script never auto-merges. You're in charge of what upstream features (if any) land in your bot.

## 🛡️ Deployment Resilience

- **Native Process:** No Docker cage for the parent. systemd user unit (Linux) or launchd agent (macOS) manages restarts.
- **Instance Lock:** PID-checked + stale-tolerant. A second process with the same bot name refuses to start (would corrupt session files).
- **Baseline Test Gate:** `bootstrap.sh` halts the install if `npm test` fails. Override via `ORI2_SKIP_TESTS=1` (not recommended).
- **Non-Fatal A2A:** Cloudflared missing / port exhausted / SDK init crash → logs loudly, the rest of the bot keeps running. `/a2a status` diagnoses.
- **Auto-Snapshot on Evolution:** Every DNA apply snapshots `.pi/` first. Last 20 kept.
- **Rate Limiting:** Per-user token bucket (`AGENT_RPM`, default 30). CLI + admins exempt.
- **Secret Redaction:** Channel logger redacts known credential patterns at write time (regex pass at the boundary, not after the fact).

## 🏆 Hall of Evolution (Milestones)

*   **April 2026:** Observability layer — `/health` aggregate + LLM-callable self-diagnosis tools + error ledger + subsystem heartbeats + proactive admin DM on drift. Ori can now answer *"am I OK?"* mid-turn.
*   **April 2026:** Fork-first install model — bootstrap detaches from upstream by default, `.ori2-baseline` marker + `scripts/sync-baseline.sh` for optional upstream pulls.
*   **April 2026:** A2A subsystem — Google-spec compliance, cloudflared tunnel manager, invitation token flow, DNA exchange with secret-scanner + snapshot-rollback, 5 phases landed incrementally.
*   **April 2026:** Baseline complete — 9 sprints + 4 follow-ups. 252 tests green. `tsc --strict` clean with `verbatimModuleSyntax` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`.
*   **April 2026:** Vault / policy engine / TOTP 2FA / multi-role ACL — ori-parity security surface.
*   **April 2026:** TypeScript / Pi SDK rebirth — cut-over from Python/ADK/LanceDB/Docker-parent. Same organism metaphor, new body.

## 📜 Related Projects

- **[Pi SDK](https://github.com/badlogic/pi-mono)** — the coding-agent framework Ori2 extends. Provides the TUI, session model, compaction, extension API, and slash-command surface.
- **[Ori (Python)](https://github.com/misunders2d/ori)** — the older sibling. Docker-heavy, LanceDB memory, Google ADK. Still maintained for existing deployments.

## 📄 License

MIT — use it, fork it, evolve it, share it.

---
_"Don't just code your tools. Raise them."_
