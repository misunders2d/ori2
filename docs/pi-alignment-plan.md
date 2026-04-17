# Ori2 — Pi Alignment Audit

**Scope:** 83 files / 20,709 LoC in `/media/misunderstood/DATA/projects/ori2/src/**`, `/media/misunderstood/DATA/projects/ori2/.pi/**`, and `/media/misunderstood/DATA/projects/ori2/scripts/**`. Audited against Pi SDK v-pinned at `/media/misunderstood/DATA/projects/ori2/node_modules/@mariozechner/pi-coding-agent`.

**Rubric:** DELETE / REPLACE / SIMPLIFY / KEEP. Every verdict has a Pi-source citation.

**Status:** awaiting operator approval before any code change. See §3 for the phased execution plan.

---

## 1. Executive summary

Ori2 has two kinds of code:
- **A legitimate multi-tenant chat/VPS platform layer** wrapped around Pi. Pi is single-agent + CLI-first; almost nothing for Telegram adapters, multi-session bot isolation, or A2A is covered by Pi. This code is justified.
- **Duplications of things Pi already owns natively** — auth file, SYSTEM prompt injection, OAuth extension registration, non-interactive mode, /reload + built-in edit tools, session persistence for plans. These are the wins.

The single most impactful change is the **auth path**: `src/onboarding/setup.ts` + `src/index.ts`'s `hydrateEnvFromVault()` writes secrets to the *wrong* env names and ignores Pi's `auth.json`. Fixing that unlocks removing the entire `GOOGLE_API_KEY` shim, replacing `PRIMARY_PROVIDER` with `defaultProvider` in `settings.json`, and lets `/login` handle subscription providers for free.

**Estimated LoC we can delete or fold:** ~1,800–2,400 of ~20,700 (~10%), with most of the savings concentrated in four extensions (`persona.ts`, `evolve.ts`, `oauth.ts`, `scheduler.ts`) and one script (`scheduled-run.ts`).

---

## 2. Per-module verdict matrix

### 2.1 `src/core/`

| File | LoC | Verdict | Pi primitive / evidence | Delta (LoC) |
|---|---|---|---|---|
| `paths.ts` | 36 | KEEP | Pi has **`PI_CODING_AGENT_DIR`** env var for config-dir override (`docs/extensions.md` §Environment Variables at line 62 of `pi-cli-workspace/SKILL.md`), but no concept of a **per-bot `data/<BOT>` data dir**. Our `botDir()` is orthogonal to Pi's config dir (we use the former for vault/memory/plans, the latter for sessions+auth). Justified. | 0 |
| `identity.ts` | 57 | KEEP | Reads `transport-origin` custom entries from the session branch. Relies directly on Pi's **`pi.appendEntry(customType, data)`** / `getBranch()` (`docs/extensions.md` §`pi.appendEntry` at line 1117, §session.md `CustomEntry` at line 251). Already a thin wrapper over Pi — this is how extensions should use the session. | 0 |
| `instanceLock.ts` | 42 | KEEP | Pi has no cross-bot PID lock. Pi's single-session assumption means one `~/.pi/agent/` per OS user; we run *N* bots per user (per-bot `PI_CODING_AGENT_DIR`), so a second `npm start` with the same `BOT_NAME` would corrupt vault/memory. No Pi equivalent. | 0 |
| `vault.ts` | 194 | KEEP (w/ note) | Pi's **`auth.json`** (`docs/providers.md` §Auth File line 76–108) stores *provider* secrets only; our vault carries `ADMIN_USER_IDS`, `INIT_PASSCODE`, `A2A_API_KEY`, `TELEGRAM_BOT_TOKEN`, OAuth clients — things Pi wouldn't know about. Keep, but **stop using vault as the authoritative store for `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / Gemini key** (write `auth.json` instead — see §3 Phase 1). Net LoC roughly unchanged. | 0 |
| `credentials.ts` | 318 | KEEP | Service tokens (GitHub PATs, ClickUp, SendGrid…) with per-credential `auth_type`/`header_name`/`username`, rotation, audit trail. Pi's `auth.json` is strictly for LLM-provider credentials with a closed provider set (`dist/env-api-keys.js` lines 86–103) — not a generic paste-a-token registry. | 0 |
| `oauth.ts` | 669 | SIMPLIFY/KEEP | Pi has **`pi.registerProvider(name, { oauth: {...} })`** for LLM-provider OAuth (`docs/custom-provider.md` §OAuth Support lines 212–270). That handles `/login`, token refresh, `auth.json` persistence for us — but only for **LLM providers**. Our OAuth is for arbitrary 3rd-party services (Google Calendar, Slack, GitHub…) that the agent will call. **No Pi equivalent for that.** KEEP as-is, but make sure the Pi equivalent is used for LLM-provider OAuth (see §4 `.pi/extensions/oauth.ts`). | 0 |
| `passcode.ts` | 77 | KEEP | Chat-based admin bootstrap. No Pi equivalent (Pi is single-user). | 0 |
| `whitelist.ts` | 372 | KEEP | Multi-platform ACL across Telegram/Slack/CLI. Pi's philosophy explicitly omits permission popups (`pi-cli-workspace/SKILL.md` line 63: *"no permission popups (use container or extension)"*). Our `whitelist.ts` is *the* extension Pi expects us to build. | 0 |
| `policy.ts` | 195 | KEEP | Per-tool policy engine (deny-precedence, `require_confirm`, `require_2fa`). Pi's `pi.on("tool_call", …) → { block: true, reason }` primitive (`docs/extensions.md` §tool_call lines 562–601) is the substrate; we're the rules engine on top. | 0 |
| `toolAcl.ts` | 281 | KEEP | Per-tool role→allow-action mapping. No Pi equivalent. | 0 |
| `staging.ts` | 289 | KEEP | `ACT-XXXXXX` approval tokens persisted, TTL, admin approve. No Pi equivalent. | 0 |
| `totp.ts` | 134 | KEEP | 2FA wrapper. No Pi equivalent. | 0 |
| `rateLimiter.ts` | 179 | KEEP | Per-user token bucket. No Pi equivalent. | 0 |
| `channelLog.ts` | 276 | KEEP | SQLite audit of inbound messages across all transports. Pi writes `session.jsonl` (`docs/session.md`) but that's per-session conversation history, not cross-platform inbound audit. Orthogonal. | 0 |
| `memory.ts` | 357 | KEEP | Long-term semantic memory (sqlite-vec, persistent across sessions). Pi's session is one-conversation scoped; compaction summarises but doesn't build an indexed recall store (`docs/compaction.md`). No Pi equivalent. | 0 |
| `embeddings.ts` | 106 | KEEP | Local fastembed singleton. Pi has no embedding service. | 0 |
| `heartbeat.ts` | 93 | KEEP | Per-subsystem liveness. Pi has no subsystem-health surface. | 0 |
| `errorLog.ts` | 196 | KEEP | JSONL error ledger for the bot's own subsystems (Telegram poll errors, tunnel crashes). Not LLM events. No Pi equivalent. | 0 |
| `health.ts` | 448 | KEEP | Aggregates the above (heartbeat, errors, adapter states). No Pi equivalent. | 0 |
| `proactiveDiagnostics.ts` | 225 | KEEP | Periodic check + admin DM on degradation. No Pi equivalent. | 0 |

**`src/core/` subtotal:** everything KEEP or SIMPLIFY-with-no-LoC-change. This is the justified "multi-user chat VPS platform" layer that Pi doesn't cover.

### 2.2 `src/a2a/` (14 files, 3,196 LoC)

| File | LoC | Verdict | Evidence | Delta |
|---|---|---|---|---|
| `types.ts` | 144 | KEEP | A2A protocol types. Pi is single-agent, per the philosophy: *"no sub-agents (use tmux or extensions)"* (`pi-cli-workspace/SKILL.md` line 63). | 0 |
| `agentCard.ts` / `.test` | 105+135 | KEEP | A2A agent-card builder. Out of Pi scope. | 0 |
| `friends.ts` / `.test` | 244+204 | KEEP | Peer registry + bearer key store. Out of Pi scope. | 0 |
| `server.ts` / `.test` | 482+342 | KEEP | Express + `@a2a-js/sdk` JSON-RPC. Out of Pi scope. | 0 |
| `client.ts` | 209 | KEEP | Outbound A2A HTTP client. Out of Pi scope. | 0 |
| `adapter.ts` / `.test` | 165+150 | KEEP | Plugs A2A into our transport dispatcher. Out of Pi scope. | 0 |
| `agentExecutor.ts` | 151 | KEEP | `@a2a-js/sdk` executor hookup. Out of Pi scope. | 0 |
| `dna.ts` / `.test` | 676+264 | KEEP | Feature package/apply/rollback over A2A. Out of Pi scope. Pi's `packages` setting (`docs/settings.md` line 168 `packages`) covers **npm/git package discovery for skills/extensions** but NOT a peer-to-peer signed-feature-exchange protocol. | 0 |
| `secretScanner.ts` / `.test` | 177+161 | KEEP | Scans DNA bundles for leaked credentials before transmit. Out of Pi scope. | 0 |
| `tunnel.ts` / `.test` | 235+86 | KEEP | cloudflared tunnel manager. Out of Pi scope. | 0 |
| `broadcaster.ts` / `.test` | 97+161 | KEEP | Address-change broadcast to friends. Out of Pi scope. | 0 |
| `invitations.ts` / `.test` | 44+57 | KEEP | Token-based peer pairing. Out of Pi scope. | 0 |
| `portAlloc.ts` / `.test` | 57+53 | KEEP | Bind-port allocation. Out of Pi scope. | 0 |
| `keyRotation.ts` / `.test` | 131+253 | KEEP | Per-friend key rotation. Out of Pi scope. | 0 |

**`src/a2a/` subtotal:** 14 files, entirely KEEP. Pi's single-agent/single-user model means A2A is 100% ori2-native scope.

### 2.3 `src/transport/` (5 files, 1,121 LoC)

| File | LoC | Verdict | Evidence | Delta |
|---|---|---|---|---|
| `types.ts` | 188 | KEEP | `Message` / `AgentResponse` / `TransportAdapter` / `AdapterStatus`. Pi has **`pi.on("input", …)`** (`docs/extensions.md` §input lines 692–736) which lets an extension intercept user input — but that's *after* a message is already inside Pi. We need to receive from *N* external platforms (Telegram, Slack, A2A, CLI) and funnel them in. No Pi equivalent. | 0 |
| `dispatcher.ts` / `.test` | 269+131 | KEEP | Inbound/outbound hub with pre-dispatch/post-block hooks. Implements the adapter-fan-in Pi deliberately omits. | 0 |
| `cli.ts` | 94 | KEEP (w/ caveat) | Correctly acknowledges Pi's `InteractiveMode` owns terminal I/O; only used for outbound messaging from extensions. Good architecture — this is the thin wrapper Pi expects. | 0 |
| `telegram.ts` | 433 | KEEP | `getUpdates` long-poll, media save, vault-backed token. Out of Pi scope. | 0 |
| `media.ts` | 137 | KEEP | Attachment serialisation across Pi's `ImageContent` + our text/binary wire format. No Pi equivalent for the latter. | 0 |

**`src/transport/` subtotal:** all KEEP. The transport abstraction is the *reason* Pi's single-CLI surface can multiplex to Telegram/Slack/A2A.

### 2.4 `src/index.ts` (381 LoC) — **the critical bootstrap**

| Concern | LoC in question | Verdict | Evidence |
|---|---|---|---|
| `hydrateEnvFromVault()` writes `GOOGLE_API_KEY` | 49–62, 94–97 | **REPLACE** | **BUG**: Pi's resolver reads `GEMINI_API_KEY`, not `GOOGLE_API_KEY`, for the `google` provider (`dist/env-api-keys.js` line 89: `google: "GEMINI_API_KEY"`). `docs/providers.md` line 59 confirms. Fix: either rename the vault key to `GEMINI_API_KEY` (preferred; same name Pi doc uses) or write to Pi's `auth.json` directly and drop the env-hydration entirely for LLM keys. See Phase 1 in §3. |
| Hydrating into `process.env` vs writing `auth.json` | same | SIMPLIFY | Pi already handles env-var lookup (`docs/providers.md` §Resolution Order lines 188–196: `--api-key > auth.json > env > models.json`). Writing a single `~/.pi/agent/auth.json` (or, with our `PI_CODING_AGENT_DIR` override, `data/<BOT>/.pi-state/auth.json`) takes higher precedence and is the Pi-native path. After the fix, `hydrateEnvFromVault()` should only hydrate non-Pi secrets (`ADMIN_USER_IDS`, `TELEGRAM_BOT_TOKEN` via vault.get still, `A2A_*`), not LLM keys. Net ~15 LoC. |
| `PI_CODING_AGENT_DIR` override per-bot | 88–92 | KEEP | Exact pattern the docs bless: `pi-cli-workspace/SKILL.md` line 62: *"`PI_CODING_AGENT_DIR` (override config dir)"*. Comment correctly explains the race we avoid. |
| `createAgentSessionRuntime` + services pattern | 222–239 | KEEP | Textbook from `docs/sdk.md` §`createAgentSessionRuntime()` lines 120–181. Implemented exactly per docs. |
| Daemon-mode detection (no-TTY branch) | 38–43, 169–201 | REPLACE (partial) | Pi has **`-p`/`--print` non-interactive mode** (`docs/rpc.md`, `pi-cli-workspace/SKILL.md` line 56) and **`--mode rpc`** (`docs/rpc.md` §Starting RPC Mode). Our daemon mode is different: it's a **long-lived headless daemon whose inbound is network-adapter traffic**, not stdin/stdout. `-p` closes stdin-drained. `--mode rpc` is a one-command-per-line JSON protocol, not for network-driven agents. So we cannot replace the whole daemon branch with Pi's modes, but **`scripts/scheduled-run.ts` CAN use Pi's `-p` or `createAgentSession()` directly** — see that row. Net 0 LoC in `index.ts`, savings in the scheduler. |
| Init passcode banner (138–153) | ~15 | KEEP | Chat-admin bootstrap, no Pi equivalent. |
| A2A wiring `startA2A()` (258–379) | ~120 | KEEP | A2A is out-of-Pi. |

**`index.ts` net delta:** ~-5 to -20 LoC, but the **correctness fix is critical**. Today, a user configuring Gemini via the wizard gets a vault with `GOOGLE_API_KEY=...` which Pi will *silently never find*. The Gemini provider will then fall through to Pi's `/login` path (OAuth) or fail.

### 2.5 `src/onboarding/setup.ts` (136 LoC) — **major Pi duplication**

| Verdict | Evidence |
|---|---|
| **SIMPLIFY** (fold 60–70% into Pi-native primitives) | Wizard responsibilities today: (1) ask for bot name → writes `BOT_NAME` to `.env`, (2) ask for admin IDs → writes to vault, (3) ask for LLM provider → writes `PRIMARY_PROVIDER` to `.env` + API key to vault under the *wrong* name (`GOOGLE_API_KEY` instead of `GEMINI_API_KEY`). |

**What Pi already provides (with citations):**

- **`/login`** (`docs/providers.md` §Subscriptions lines 14–24) — interactive OAuth for Claude Pro/Max, ChatGPT Plus, Gemini CLI, GitHub Copilot, Google Antigravity. Handles browser/device flows and persists to `auth.json` with refresh. We reimplement *none* of this and miss the 4 subscription providers.
- **`auth.json`** (`docs/providers.md` §Auth File lines 76–108) — `{ "google": { "type": "api_key", "key": "..." }, ... }`. Created with 0600 perms. **Takes priority over env vars**. Our "write vault and push to env" path is literally reimplementing a worse version of this.
- **`defaultProvider` / `defaultModel` in `settings.json`** (`docs/settings.md` line 18) — our `PRIMARY_PROVIDER` is a duplicate that only our code reads; no Pi component consumes it.

**Proposed refactor (not done, per audit-only guardrail):**

1. Wizard collects: bot-name → `.env` (only), admin IDs → vault, provider choice → write **`data/<BOT>/.pi-state/auth.json`** `{ "<pi-provider-name>": { "type": "api_key", "key": "..." } }` and **`data/<BOT>/.pi-state/settings.json`** `{ "defaultProvider": "<name>" }`. Use Pi's provider-name (`anthropic`/`openai`/`google`) — see mapping below.
2. Drop `PRIMARY_PROVIDER` from `.env` and from `hydrateEnvFromVault()`.
3. For subscription providers, skip the API key question and tell the user to run `/login` after first boot.

Provider-name mapping (from `dist/env-api-keys.js` lines 86–103 + `docs/providers.md`): our choice → Pi name/auth.json key:
- Gemini → `google`
- Anthropic → `anthropic`
- OpenAI → `openai`

**Net delta:** ~-50 LoC in `setup.ts`, **+a user-visible upgrade** (/login works, subscription users don't need API keys, Pi reads credentials natively).

### 2.6 `.pi/extensions/` (17 files, ~6,700 LoC)

| File | LoC | Verdict | Evidence | Delta |
|---|---|---|---|---|
| `persona.ts` | 63 | **REPLACE** | Pi has **`APPEND_SYSTEM.md`** (and `SYSTEM.md`) at `.pi/APPEND_SYSTEM.md` or `~/.pi/agent/APPEND_SYSTEM.md` — `pi-cli-workspace/SKILL.md` line 52: *"Replace the default system prompt with `.pi/SYSTEM.md` … Append without replacing via `APPEND_SYSTEM.md` at the same locations."* Our static lines (identity banner + NEVER-OUTPUT-KEYS + self-evolution pointer) go verbatim into `.pi/APPEND_SYSTEM.md`. **Dynamic parts** (`if (has("a2a_send")) …` conditionals) CAN'T go in a static file; KEEP a tiny `before_agent_start` handler *only* for the dynamic directives (strip identity/persona/SELF-EVOLUTION/never-log-credentials — all static). | -35 to -45 |
| `evolve.ts` | 303 | **SIMPLIFY** | Pi provides **`write` / `edit` built-in tools** (`pi-cli-workspace/SKILL.md` line 54: *"Default four: `read`, `bash`, `edit`, `write`"*) and **`/reload` slash command** (`docs/extensions.md` §`ctx.reload()` lines 955–978). Our `evolve_extension`/`evolve_skill` are wrappers around atomic-write-to-`.pi/extensions/` that also have a path allow-list and admin-check. Pi's `write` tool combined with `protected-paths` extension example (`node_modules/@mariozechner/pi-coding-agent/examples/extensions/protected-paths.ts`) gives the same result. **Keep** the admin-gated path allow-list (valuable) and the `/evolve diff` command; **drop** the `evolve_extension`/`evolve_skill` tools entirely — tell the agent to just use `write` + `/reload`. | -150 to -200 |
| `diagnostics.ts` | 415 | KEEP | Health/errors/channel-log readers, Telegram/A2A live probes. Pi has none. Tools map 1:1 to our core modules. | 0 |
| `admin_gate.ts` | 782 | KEEP | Pre-dispatch whitelist, `/init`, staging, role management, tool ACL. Pi's philosophy explicitly omits permission popups (`pi-cli-workspace/SKILL.md` line 63); this is the extension Pi expects. | 0 |
| `audit_and_limits.ts` | 323 | KEEP | Channel log + rate limit wiring. No Pi equivalent. | 0 |
| `credentials.ts` | 456 | KEEP | Surface for `src/core/credentials.ts`. No Pi equivalent (service tokens, not LLM keys). | 0 |
| `dna.ts` | 466 | KEEP | Surface for `src/a2a/dna.ts`. Out-of-Pi. | 0 |
| `guardrails.ts` | 375 | KEEP | Prompt-injection defence via embeddings. Pi has no guardrail layer. | 0 |
| `memory.ts` | 401 | KEEP | Surface for `src/core/memory.ts`. | 0 |
| `npm_security.ts` | 101 | KEEP | Blocks raw `bash npm install`. Valuable operator guardrail. No Pi equivalent. | 0 |
| `oauth.ts` | 722 | **SIMPLIFY** (mild) | For 3rd-party-service OAuth (Slack, ClickUp, Calendar…) this KEEPs. **But**: if any LLM-provider-OAuth is registered here (none today, but the code structure allows it), that case should be migrated to Pi's `pi.registerProvider(name, { oauth: {...} })` per `docs/custom-provider.md` §OAuth Support lines 212–270. Audit shows the current `BUILTIN_TEMPLATES` are for non-LLM services, so **no migration needed today**. Note this as guidance for future additions. | 0 |
| `plan_enforcer.ts` | 773 | SIMPLIFY | Stores `ENTRY_TYPE = "plan-enforcer"` custom entries via `pi.appendEntry()` — this IS the Pi-native pattern (`docs/extensions.md` §`pi.appendEntry` line 1117, §session.md `CustomEntry` line 251). Good. However, the **parallel disk files** under `data/<BOT>/active-plans/<sessionId>.json`, `plan-threads/`, `plan-reports/`, `plan-control/` are needed because we query plans *across sessions* (admin from session A wants to abort a scheduled session B). Pi's `SessionManager.listAll()` (`docs/session.md` §Static Listing Methods line 372) would let us *discover* peer sessions but reading their `.jsonl` and filtering for our custom entries is O(all-entries). Disk index wins on reasonable bot sizes. **KEEP the disk files; file for future optimisation when `SessionManager.listAll()` gets an indexed variant.** | 0 |
| `scheduler.ts` | 470 | **SIMPLIFY** (dependent on fix below) | Uses `SessionManager.create(runsDir)` (Pi-native) + spawns `npx tsx scripts/scheduled-run.ts` subprocess. The spawn-subprocess model is defensible (isolation, no parent session contamination) but see `scripts/scheduled-run.ts` row. The scheduler itself stays roughly unchanged. | 0 |
| `tdd_enforcer.ts` | 52 | KEEP | `verify_and_commit` tool (runs `npm test` then commits). No Pi equivalent. | 0 |
| `transport_bridge.ts` | 282 | KEEP | Wires `dispatcher.pushToPi` to `pi.sendUserMessage` (`docs/extensions.md` §`pi.sendUserMessage` line 1089) + on `agent_end` routes the response back to the originating adapter. Tagging sessions with `transport-origin` uses `pi.appendEntry` (Pi-native). This IS the extension pattern Pi encourages. | 0 |
| `web_tools.ts` | 105 | KEEP | `web_fetch` / `web_search` tools. Pi provides `read`/`bash`/`edit`/`write` only (`pi-cli-workspace/SKILL.md` line 54). No Pi-native web tools. | 0 |
| `a2a.ts` | 591 | KEEP | A2A operator + LLM surface. Out-of-Pi. | 0 |

**`.pi/extensions/` subtotal:** ~-185 to -245 LoC from `persona.ts` + `evolve.ts` only. Everything else KEEP.

### 2.7 `scripts/` (5 files)

| File | LoC | Verdict | Evidence | Delta |
|---|---|---|---|---|
| `scheduled-run.ts` | 124 | **REPLACE** | Pi has **`-p`/`--print`** (`pi-cli-workspace/SKILL.md` line 56, `README.md` §Modes) for non-interactive runs: `pi -p "kickoff text"`. Our subprocess re-imports `SessionManager`, `createAgentSessionServices`, `createAgentSessionFromServices`, hydrates env, registers adapters, calls `session.prompt()` — we're reinventing `-p` from inside our codebase. Two ways to replace: (a) invoke the installed `pi` binary with `-p` + `--session <file>` + `--session-dir …` — simplest but forces a subprocess round-trip through the CLI; (b) keep our in-process `createAgentSession()` call (Pi's own SDK pattern, `docs/sdk.md` §Quick Start line 18) but drop the adapter registration (the agent's output gets piped via our transport_bridge inside the subprocess — but then why spawn at all?). **The real question:** do we need a *subprocess* at all? Pi's SDK supports multiple `AgentSession` instances in one process (`docs/sdk.md` §`createAgentSession()`). If the scheduler ran the scheduled prompt in-process against a detached `SessionManager`, we delete ~100 LoC of subprocess plumbing. That's a Phase-3 refactor. Simplest first step: **keep the subprocess but replace 80% of the code with a `pi -p <kickoff>` exec**. | -70 to -100 |
| `a2a-smoke.ts` | 301 | KEEP | A2A integration smoke test. Operator tooling. | 0 |
| `a2a-smoke-peer.ts` | 65 | KEEP | A2A integration smoke peer. Operator tooling. | 0 |
| `postinstall-prewarm.cjs` | 73 | KEEP | Warms the BGE fastembed ONNX model download on `npm install`. Orthogonal. | 0 |
| `sync-baseline.sh` | - | KEEP | Git baseline sync. Operator tooling. | 0 |

### 2.8 `.pi/skills/` + `.pi/prompts/`

| File | Verdict | Evidence |
|---|---|---|
| `.pi/skills/adding-capabilities/SKILL.md` | KEEP | Layout (`<skill-name>/SKILL.md`) matches `docs/skills.md` §Locations lines 28–42 and §SKILL.md Format lines 108–129. Frontmatter (`name` + `description`) correct. |
| `.pi/skills/evolution-sop/SKILL.md` | KEEP | Same — correct layout + frontmatter. |
| `.pi/skills/github-setup/SKILL.md` | KEEP | Same — correct. |
| `.pi/prompts/Platform_Controller.md` | **REPLACE** (filename + content move) | Per `docs/prompt-templates.md` line 31: *"The filename becomes the command name. `review.md` becomes `/review`."* Our filename `Platform_Controller.md` would register as `/Platform_Controller` (uppercase leading, underscore) — valid but weird. More importantly: the file content (`"You are the Platform Controller. …"`) is a **system-prompt line**, not a prompt *template* the user would type. It belongs in **`.pi/APPEND_SYSTEM.md`** (`pi-cli-workspace/SKILL.md` line 52). Right now `persona.ts` also reads from `.pi/prompts/<BOT_NAME>.md` — two competing sources of the same concept. After the `persona.ts` fix, delete `.pi/prompts/Platform_Controller.md`. |

---

## 3. Sequenced change plan

Each phase is independently shippable. Early phases unblock later ones; don't reorder.

### Phase 1 — Auth path (correctness + unblock)

**Goal:** Fix Gemini key name; stop duplicating Pi's credential resolution.

**Changes:**
1. `src/onboarding/setup.ts`: when provider is Gemini, write `GEMINI_API_KEY` (not `GOOGLE_API_KEY`) to vault.
2. `src/index.ts` `hydrateEnvFromVault()`:
   - Rename `GOOGLE_API_KEY` in `VAULT_HYDRATED_KEYS` to `GEMINI_API_KEY`.
   - Add a one-shot vault migration: if vault has `GOOGLE_API_KEY` but no `GEMINI_API_KEY`, rename + write + delete old.
   - Add the same rename to `scripts/scheduled-run.ts`.
3. **Optional follow-up (same phase):** Instead of hydrating into `process.env`, write `<PI_CODING_AGENT_DIR>/auth.json` on first boot if it doesn't exist, seeded from vault's `*_API_KEY` entries. Still hydrate env as a belt-and-braces for transport/A2A code that reads `process.env.*`.

**Verification:**
- Wizard-fresh Gemini install → `pi --model google/…` (inside a session) resolves a valid model.
- Existing vaults with `GOOGLE_API_KEY` still work after one boot.
- Onboarding test: `npm test` passes.

**Risk:** LOW. This is a rename + migration, not a behaviour change.

### Phase 2 — SYSTEM prompt (`persona.ts`)

**Goal:** Move static global directives into `.pi/APPEND_SYSTEM.md`; shrink `persona.ts` to dynamic-only injection.

**Changes:**
1. Create `.pi/APPEND_SYSTEM.md` with the static lines currently in `persona.ts` directives: *"You are operating within a multi-agent platform (Ori2)."* + *"Never output raw API keys…"* + self-evolution pointer.
2. Keep the `${botName}` identity line in `persona.ts` *or* use `$BOT_NAME` substitution — Pi doesn't interpolate env in `APPEND_SYSTEM.md`, so either keep persona for identity or write the file at boot.
3. Strip static directives from `persona.ts`; keep only tool-conditional bullets.
4. Delete `.pi/prompts/Platform_Controller.md` (dead).
5. Delete the `.pi/prompts/<BOT_NAME>.md` path from `persona.ts` if not used, OR keep but make it explicitly "custom bot-specific persona" and tell the agent to edit `APPEND_SYSTEM.md` for global rules.

**Verification:** Start a session, confirm static directives still reach the agent's system prompt (ask *"What are your global directives?"*); remove a tool, confirm that tool's dynamic line disappears.

**Risk:** MEDIUM. The persona directive is load-bearing for operator-facing safety claims. Behaviour-preserving move; verify end-to-end.

**Dependency:** None.

### Phase 3 — Evolve extension (`evolve.ts`)

**Goal:** Replace `evolve_extension`/`evolve_skill` tools with documentation that says "use `write` + `/reload`".

**Changes:**
1. Delete the two tool registrations.
2. Keep `evolve_list` + `/evolve help` / `/evolve diff` (they're genuine operator aids).
3. Update `.pi/skills/evolution-sop/SKILL.md` Phase 4 ("Secure Scaffolding"): replace `evolve_extension(...)` with `write(path=".pi/extensions/foo.ts", ...)` then `/reload`.
4. Keep the `npm_security` extension's raw-bash guardrail; it still matters.

**Verification:** Agent can still write an extension and `/reload` it via the `write` tool. Admin path allow-list is still enforced — now via Pi's built-in tools + `protected-paths` example pattern (reference `node_modules/@mariozechner/pi-coding-agent/examples/extensions/protected-paths.ts`).

**Risk:** MEDIUM. Downstream: the evolution-sop skill and persona prompt both mention `evolve_extension`. Grep before deleting.

**Dependency:** None (can run parallel with Phase 2).

### Phase 4 — Scheduled-run (`scripts/scheduled-run.ts`)

**Goal:** Drop hand-rolled subprocess bootstrap in favour of `pi -p` (or in-process SDK).

**Choice A (simpler):** `scripts/scheduled-run.ts` becomes a 20-line `spawn("pi", ["-p", kickoff, "--session", sessionFile, ...])` wrapper. Drops our manual `createAgentSession…` calls.

**Choice B (deeper):** scheduler extension runs scheduled prompts in-process via a detached `SessionManager.create()` + `createAgentSession({ sessionManager })`. Zero subprocess — `docs/sdk.md` §Quick Start line 18. Saves all ~120 LoC but requires careful hook-isolation (current-session hooks must not fire for scheduled runs).

**Start with Choice A; upgrade to B when we have operator telemetry confirming no cross-session hook bleed.**

**Verification:** Trigger a scheduled job manually (`trigger_scheduled_task_now`); confirm output lands in the originating channel; confirm plan_enforcer steers correctly.

**Risk:** HIGH. This is a hot path for any operator using scheduling. Need smoke tests first.

**Dependency:** Phase 1 (auth path) must be correct first or the scheduled subprocess won't find credentials either.

### Phase 5 — `settings.json` alignment (housekeeping)

**Goal:** Retire `PRIMARY_PROVIDER` in `.env`; use Pi's `defaultProvider` in `settings.json`.

**Changes:**
1. Wizard writes `<PI_CODING_AGENT_DIR>/settings.json` with `{ "defaultProvider": "<name>", "defaultModel": "<id-if-chosen>" }`.
2. Delete all reads of `process.env.PRIMARY_PROVIDER` — confirm with grep none are load-bearing. (Short audit shows it's only set, never read by ori2 source — verify before cutting.)

**Verification:** Starting the bot with no env overrides loads the wizard-chosen provider via Pi's native path.

**Risk:** LOW.

**Dependency:** Phase 1.

---

## 4. Risks & dependencies

| Risk | Severity | Mitigation |
|---|---|---|
| Existing vaults have `GOOGLE_API_KEY` — Phase 1 rename breaks them without migration | HIGH | Ship the in-place migration in the same commit; tested against a fixture vault. |
| Persona-prompt change (Phase 2) alters LLM behaviour in subtle ways | MEDIUM | Diff the rendered system prompt before/after across a handful of golden prompts. |
| Evolve-tools removal (Phase 3) breaks agents that learned to call `evolve_extension` from memory | MEDIUM | Keep a stub tool for 1 release that prints "deprecated — use `write` + `/reload`" and blocks. |
| `scripts/scheduled-run.ts` Choice B (in-process) risks hook/session cross-contamination | HIGH | Stick with Choice A for v1; revisit B after observability hardens. |
| Vertex/Bedrock/Azure/OpenRouter users currently work via env vars in `.env` | LOW | `hydrateEnvFromVault` only touches *vault-stored* keys; existing env-var configs are untouched. |
| Pi updates rename `defaultProvider` / `defaultModel` / `auth.json` shape | LOW | Keep migration guard at boot that reads Pi's current `settings.json` schema and logs if it's unexpected. |

---

## 5. Top-5 biggest wins (tackle first)

1. **Phase 1 (auth path rename + migrate)** — fixes a real bug today (Gemini key silently ignored by Pi). Unblocks everything. ~20 LoC changed + ~40 LoC migration.
2. **Phase 2 (persona.ts → APPEND_SYSTEM.md)** — deletes ~35-45 LoC; replaces ad-hoc `before_agent_start` with Pi-bless static prompt file. Upgrades any operator who edits `.pi/APPEND_SYSTEM.md` at home.
3. **Phase 3 (evolve.ts tools → write + /reload)** — deletes ~150-200 LoC; fewer hand-rolled tools the agent has to pick between.
4. **Phase 4 Choice A (scheduled-run.ts → `pi -p`)** — deletes ~70-100 LoC; now just a thin subprocess shim.
5. **Phase 5 (`PRIMARY_PROVIDER` → `defaultProvider`)** — ~5 LoC, but closes a provenance gap: today the wizard writes a value no Pi component consumes.

**Combined effect:** ~280-400 LoC deleted plus the bug fix, all achievable in 1-2 working days of focused work.

---

## 6. "Don't touch" list — things Pi explicitly omits

Per `pi-cli-workspace/SKILL.md` §Philosophy line 63 (*"No MCP, no sub-agents, no permission popups, no plan mode, no built-in todos, no background bash. Everything is buildable via extensions."*) and `README.md` §Philosophy, the following ori2 code is **justified-by-design** even though it looks like "a feature Pi could have":

| Ori2 code | Pi explicitly omits | Why ori2 KEEP |
|---|---|---|
| `src/core/whitelist.ts`, `policy.ts`, `toolAcl.ts`, `staging.ts`, `admin_gate.ts` | "no permission popups" | Pi leaves auth/permissions to the extension. We are that extension. |
| `plan_enforcer.ts` | "no plan mode" | Same — Pi punts to extensions. |
| `subagent/` pattern (we don't have sub-agents, but **`src/a2a/`** is the peer-to-peer answer instead) | "no sub-agents" | Pi's own `examples/extensions/subagent/` is an in-process pattern; our A2A is out-of-process/peer-to-peer. Both valid. |
| `src/transport/dispatcher.ts` + adapters (Telegram, CLI fan-out) | "no background bash" / single-terminal design | Multi-platform inbound is our explicit product surface. |
| No built-in todos — we also don't have one | "no built-in todos" | Good; don't add one. |

**Do NOT "rationalise" these into Pi primitives that don't exist.**

---

## 7. Bugs found during audit (not fixed — report-only)

1. **[HIGH] `src/onboarding/setup.ts:116` + `src/index.ts:51` + `scripts/scheduled-run.ts:50`** — store Google key as `GOOGLE_API_KEY` but `@mariozechner/pi-ai/dist/env-api-keys.js:89` maps provider `google` → `GEMINI_API_KEY`. Gemini users are silently broken (their key never reaches Pi's resolver). **Fix in Phase 1.** Evidence: full citation above.
2. **[MEDIUM] `src/onboarding/setup.ts:128`** — writes `REQUIRE_2FA=true` to `.env`, but a grep shows no code path reads it. Either wire it in or drop it.
3. **[LOW] `.pi/prompts/Platform_Controller.md`** — content belongs in `APPEND_SYSTEM.md`. It *will* work today as a prompt template registered as `/Platform_Controller`, but that's almost certainly not the intent.
4. **[LOW] `src/index.ts:88-92`** — `PI_CODING_AGENT_DIR` is correctly set, but we don't also ensure `data/<BOT>/.pi-state/auth.json` exists. Pi creates it on first `/login` but if we ever want to seed an API key into `auth.json` on behalf of the wizard (Phase 1 follow-up), we need to pre-create the dir.
5. **[LOW] `.pi/extensions/tdd_enforcer.ts:29-30`** — `execAsync(\`git commit -m "${params.commit_message.replace(/"/g, '\\\\"')}"\`)` is shell-injection-adjacent. Escape is naive (doesn't handle backticks, `$()`, newlines). Safer: `spawn("git", ["commit", "-m", msg])` — no shell. (Orthogonal to Pi alignment; flagging only.)

---

## 8. Summary table of deletable/replaceable LoC

| Phase | Module | LoC delta | Confidence |
|---|---|---|---|
| 1 | `src/onboarding/setup.ts`, `src/index.ts`, `scripts/scheduled-run.ts` (key rename) | ~0 net, +bug fix | HIGH |
| 2 | `.pi/extensions/persona.ts` | -35 to -45 | HIGH |
| 2 | `.pi/prompts/Platform_Controller.md` | -3 | HIGH |
| 3 | `.pi/extensions/evolve.ts` | -150 to -200 | MEDIUM (docs/skill rewrite needed too) |
| 4 | `scripts/scheduled-run.ts` | -70 to -100 | MEDIUM (risk-dependent) |
| 5 | `src/onboarding/setup.ts`, `src/index.ts` (`PRIMARY_PROVIDER` -> `defaultProvider`) | -15 | HIGH |
| — | *Everything else* | 0 | HIGH (justified by Pi's philosophy-gap) |
| **Total** | — | **~-275 to -360 LoC + 1 bug fix** | — |

No structural refactors; every phase is 1-2-day scope. After Phase 1+2, the bot is already meaningfully more Pi-native in surface behaviour; Phases 3-5 are LoC wins with small behavioural deltas.

---

## 9. Execution checklist (for the implementer — update as we go)

- [ ] **Phase 1 — Auth path**
  - [ ] Rename vault key `GOOGLE_API_KEY` → `GEMINI_API_KEY` in wizard write path (`src/onboarding/setup.ts`).
  - [ ] Update `VAULT_HYDRATED_KEYS` in `src/index.ts`.
  - [ ] Add one-shot vault migration (boot-time, writes new key + deletes old).
  - [ ] Update `scripts/scheduled-run.ts` to hydrate `GEMINI_API_KEY`.
  - [ ] (Optional follow-up) Seed `data/<BOT>/.pi-state/auth.json` from vault on first boot.
  - [ ] E2E test: fresh vault Gemini install → reply from Pi TUI.
  - [ ] E2E test: existing `GOOGLE_API_KEY`-only vault → migration runs, bot works.
- [ ] **Phase 2 — SYSTEM prompt**
  - [ ] Create `.pi/APPEND_SYSTEM.md` with static directives.
  - [ ] Strip static lines from `persona.ts`.
  - [ ] Delete `.pi/prompts/Platform_Controller.md`.
  - [ ] Decide on `.pi/prompts/<BOT_NAME>.md` fate (keep as bot-specific persona, or drop).
  - [ ] E2E test: ask agent "what are your global directives" → answer includes the new static lines.
- [ ] **Phase 3 — Evolve extension**
  - [ ] Delete `evolve_extension` + `evolve_skill` tool registrations from `.pi/extensions/evolve.ts`.
  - [ ] Keep `evolve_list` + `/evolve diff` / `/evolve help` slash commands.
  - [ ] Update `.pi/skills/evolution-sop/SKILL.md` Phase 4 to use `write` + `/reload`.
  - [ ] Grep for callers of `evolve_extension` / `evolve_skill`; deprecate gently with a stub if needed.
  - [ ] Consider adopting Pi's `examples/extensions/protected-paths.ts` pattern for the allow-list.
- [ ] **Phase 4 — Scheduled-run**
  - [ ] Refactor `scripts/scheduled-run.ts` to use `spawn("pi", ["-p", kickoff, "--session", sessionFile])` (Choice A).
  - [ ] Regression test: schedule a job, trigger it, verify output round-trips via transport_bridge.
  - [ ] File a follow-up task for Choice B (in-process) once observability is in place.
- [ ] **Phase 5 — `settings.json` alignment**
  - [ ] Wizard writes `<PI_CODING_AGENT_DIR>/settings.json` with `defaultProvider` (+ optional `defaultModel`).
  - [ ] Grep-confirm `process.env.PRIMARY_PROVIDER` has no readers; delete write.
  - [ ] Update docs / INSTALL.md references.
- [ ] **Orthogonal bugs (do them as side-quests)**
  - [ ] Wire or remove `REQUIRE_2FA` in `.env` (§7.2).
  - [ ] Replace `execAsync` in `tdd_enforcer.ts` with `spawn` (§7.5).
  - [ ] Ensure `data/<BOT>/.pi-state/auth.json` is pre-created if we seed it (§7.4).

---

**Audit performed:** 2026-04-17 by superpowers:code-reviewer agent, against ori2 HEAD `ff14b36`.

**Next action:** operator reviews this file; on approval, execute Phase 1 then open a PR.
