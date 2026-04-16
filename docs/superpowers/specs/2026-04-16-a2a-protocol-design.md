# A2A Protocol Implementation — Design Spec

**Date:** 2026-04-16
**Status:** Approved for planning
**Scope:** Phase 1 — full peer-to-peer A2A messaging + DNA exchange. Streaming, Synapse-spawn capability, Docker-child spawning, mTLS deferred.

## Problem

ori2 currently has no internet-grade agent-to-agent communication. The existing `.pi/extensions/synapse_a2a.ts` is a stub that wraps the local-host Synapse CLI (which is not installed in any production deployment) and implements an inbox-dir convention nothing currently writes to. There is no way for two ori2 instances on different VPSs to communicate, no way for ori2 to talk to a third-party A2A-spec-compliant agent (e.g., the operator's website agent), and no way to share evolved tools/skills between department forks of ori2.

## Goals

1. **Real Google A2A protocol compliance.** `.well-known/agent.json` discovery, JSON-RPC 2.0 endpoint, `message/send` / `tasks/get` / `tasks/cancel` task lifecycle, bearer-key authentication. Compliant enough that any A2A-spec agent (not just other ori2 instances) can register as a friend and exchange messages.
2. **Bilateral friendship model.** Agents become "friends" through a deliberate exchange of bearer keys, scoped to that pair. No central authority. Either side can revoke unilaterally by deleting the friend record.
3. **Tunnel-aware deployment.** Default operating mode is behind a free Cloudflare Tunnel that gets a new ephemeral URL per restart. ori2 manages the cloudflared child process, detects the assigned URL, regenerates its agent card, and broadcasts the new URL to all registered friends — they auto-update their stored URL for us. No manual reconfiguration needed when tunnels rotate.
4. **DNA exchange at feature grain.** Operators declare named features (an integration, tool, or skill — each backed by a specific list of files in `.pi/`). Friends discover available features via the agent card's `skills[]` array. A friend pulls a specific feature by ID; the source bot packages it on the fly with secret-scrubbing, the consumer bot stages it, conflict-checks against its own `.pi/`, and applies after explicit operator approval. Snapshot-rollback on test failure post-apply.
5. **No port conflicts when running multiple ori2 instances on one host.** Per-checkout isolation extends to the A2A bind port — sticky preferred port (default 8085) walks on `EADDRINUSE`, persists actual port back to vault for subsequent restarts.
6. **Non-fatal subsystem.** A2A bootstrap failures (cloudflared missing, port walking exhausted, SDK init crash) are logged loudly but do not kill the bot. The rest of ori2 keeps running; admin can `/a2a status` to diagnose.

## Non-goals (deferred)

- **`message/stream` SSE streaming.** Phase 1 is poll-only; agent card declares `streaming: false`. SDK supports both, so this is a one-flag change in a future commit.
- **Synapse-spawn capability** (`synapse spawn` wrapping for Claude Code / Gemini / Codex / OpenCode workers). Different problem, different design questions, separate extension when needed.
- **Docker-child spawning** (ori's `spawn.py` model — hierarchical fleet with isolated container children). Out of scope.
- **mTLS / signed JWTs / PKI.** Bearer key per friend is sufficient for the threat model (peer-to-peer trust, established via deliberate exchange).
- **Federation / discovery service** (DNS-SD, central registry). Friends are added by URL; no auto-discovery.
- **Auto-approve inbound friend requests.** Adding a friend is always operator-initiated.

## Architecture overview

### Module map

| File | Purpose | LOC est. |
|---|---|---|
| `src/a2a/server.ts` | HTTP server: `@a2a-js/sdk` wrapped with `x-a2a-api-key` middleware, custom routes (`/a2a/address-update`, `/a2a/friend-accept`, `/dna/<feature>`, `/health`). Bridges incoming `message/send` into the dispatcher hook chain. | ~250 |
| `src/a2a/client.ts` | Outbound SDK client wrapper. `message/send` + poll `tasks/get` until terminal. | ~200 |
| `src/a2a/agentCard.ts` | Pure builder for the v1.0 agent card from vault config + DNA feature catalog. | ~120 |
| `src/a2a/friends.ts` | Friend registry (`data/<bot>/friends.json` + per-friend bearer keys in vault). Add/remove/list/key-rotation/address-update. | ~200 |
| `src/a2a/tunnel.ts` | cloudflared child process manager. Spawn, parse URL, persist, restart-on-crash, graceful shutdown. | ~180 |
| `src/a2a/dna.ts` | DNA feature catalog + on-the-fly packaging + secret scanner + import/staging/snapshot/apply/rollback. | ~350 |
| `src/a2a/types.ts` | Shared types — `Friend`, `AgentCard`, `DnaFeature`, `DnaManifest`, etc. | ~100 |
| `.pi/extensions/a2a.ts` | Pi extension. Registers as `TransportAdapter` for platform `a2a`. Registers all LLM tools and slash commands. | ~400 |
| Tests: `*.test.ts` for friends, agentCard, dna, tunnel, plus integration | ~500 |
| **Total new code** | | **~2300 LOC** |

### Data flow — inbound (peer calls us)

```
peer HTTPS request to https://abc-def.trycloudflare.com
  → Cloudflare Tunnel
  → cloudflared subprocess (child of ori2)
  → 127.0.0.1:<allocated-port>
  → @a2a-js/sdk handler
  → x-a2a-api-key middleware → resolves bearer to friend name (or 401)
  → message/send handler
  → adapt to Message{platform:"a2a", senderId:"a2a:<friend-name>"}
  → dispatcher pre-hooks (whitelist, rate limit, guardrails, admin gate)
  → pi.sendUserMessage → agent processes → response
  → wrap as A2A Task, return task ID
  → peer polls tasks/get until status terminal, retrieves response
```

The friend's bearer key is what authenticates them as a peer. The whitelist gate then determines whether `a2a:<friend-name>` is permitted to interact at all (default: any registered friend is whitelisted as `user` role; `/role grant a2a <name> admin` for elevated peers).

### Data flow — outbound (we call peer)

```
LLM tool call_friend(name, message, wait?=true)
  → friends.get(name) → {url, ourKeyForThem}
  → @a2a-js/sdk Client.sendMessage(
      url + "/", message, headers={"x-a2a-api-key": ourKeyForThem}
    )
  → poll tasks/get every 1.5s up to timeout (default 5min)
  → extract response text from terminal task
  → return to LLM
```

## Wire protocol

### Endpoints

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/.well-known/agent.json` | GET | none (public) | v1.0 A2A agent card. Includes `dna:<feature-id>` skill entries. |
| `/.well-known/agent-card.json` | GET | none | Alias for above. |
| `/` | POST | `x-a2a-api-key` | JSON-RPC 2.0 — `message/send`, `tasks/get`, `tasks/cancel` (handled by SDK). |
| `/a2a/address-update` | POST | `x-a2a-api-key` | Custom: `{sender_name, new_base_url}`. Match by key first, name second. Update friend record. |
| `/a2a/friend-accept` | POST | `<inviter-key>` | Invitation callback: `{accepting_name, accepting_url, accepting_key}`. Finalises mutual trust. |
| `/dna/<feature-id>.tar.gz` | GET | `x-a2a-api-key` | Custom: package the named feature on the fly, stream as gzip tarball. ACL-checked against the feature's `share_with`. |
| `/health` | GET | none | Liveness probe. Returns `{status, bot_name, uptime_s, friend_count}`. |

**Auth middleware behaviour.** Two distinct patterns:
- **Standard endpoints** (`/`, `/a2a/address-update`, `/dna/<feature>`): the `x-a2a-api-key` header value must match a stored `a2a:friend_key:<name>` entry in vault. The middleware resolves the key to a friend name and attaches it to the request context (used downstream for `share_with` ACL checks and dispatcher `senderId`).
- **`/a2a/friend-accept`**: special-cased. Authenticates against the in-memory map of *outstanding* invitation tokens (`a2a:friend_key:<name>` entries with status=`pending`), not the regular registered-friends keys. The invitation token's TTL bounds the window. On successful accept, the entry transitions from pending to active.

### Agent card shape

```json
{
  "id": "ori2-amazon-bot",
  "name": "AmazonBot",
  "version": "1.0.0",
  "description": "Amazon listings + inventory ops bot.",
  "url": "https://abc-def-ghi.trycloudflare.com",
  "provider": { "organization": "Ori2 Project", "url": "https://abc-def-ghi.trycloudflare.com" },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "endpoints": [
    { "type": "json-rpc", "url": "https://abc-def-ghi.trycloudflare.com" }
  ],
  "capabilities": {
    "streaming": false,
    "pushNotifications": false,
    "multiTurn": true,
    "extendedAgentCard": false
  },
  "skills": [
    { "id": "general-conversation", "name": "general-conversation",
      "description": "...", "tags": ["conversation"] },
    { "id": "dna:clickup-integration", "name": "clickup-integration",
      "description": "Create/list/comment ClickUp tasks. Verified working on AmazonBot for 30 days.",
      "tags": ["dna", "integration", "crm", "clickup"] }
  ],
  "securitySchemes": {
    "apiKey": { "type": "apiKey", "name": "x-a2a-api-key", "in": "header" }
  },
  "security": [{ "apiKey": [] }]
}
```

The `dna:` skill prefix lets requesters distinguish DNA-exchangeable features from declarative skills like `general-conversation`.

**Skill list composition.** The agent card's `skills[]` array is the union of three sources, in order:
1. **Fixed core skills** baked into `agentCard.ts` (always present): `general-conversation`.
2. **`A2A_SKILLS_JSON`** vault entry (operator-curated additions): a JSON array of full skill objects appended to the fixed list. Use to declare bot-specific public capabilities like `amazon-listings-ops` for AmazonBot.
3. **DNA features** from `dna_features.json`: each registered feature appears as `{id: "dna:<feature-id>", name, description, tags: ["dna", ...]}`.

The card is regenerated on disk whenever any source changes (boot, tunnel URL change, feature register/unregister, manual `/a2a card --refresh`).

## Friend lifecycle

### State at rest

`data/<bot>/friends.json` (atomic-write, mode 0600):
```json
{
  "version": 1,
  "updated_at": 1713300000000,
  "friends": {
    "WebAgent": {
      "name": "WebAgent",
      "base_url": "https://chat.example.com",
      "endpoint_url": "https://chat.example.com",
      "agent_id": "webagent-prod-1",
      "added_at": 1713200000000,
      "added_by": "telegram:12345",
      "last_address_update": 1713290000000,
      "last_seen_at": 1713295000000,
      "card_skills": ["general-conversation", "site-search"]
    }
  }
}
```

Vault holds matching bearer keys. Two keys per friend (asymmetric):
- `a2a:friend_key:<name>` — the key WE ASSIGNED to the friend; what they must present when calling us
- `a2a:friend_outbound_key:<name>` — the key THEY ASSIGNED to us; what we present when calling them

Keeping keys out of `friends.json` means a friends-list backup/leak doesn't expose authentication material; vault has its own access controls.

### Invitation flow (recommended UX)

1. **Side A** operator runs `/a2a invite WebAgent`.
   - ori2 generates `inviter_key` (32 hex bytes), stores it as `a2a:friend_key:WebAgent` (pending).
   - Returns a token: `base64(json({inviter_name, inviter_url, inviter_key, invite_id, expires_at}))`. Token TTL: 1 hour.
   - Operator copies the token, sends it to Side B's operator (chat, email, whatever).
2. **Side B** operator runs `/a2a accept <token>`.
   - Decodes the token. Validates `expires_at`, fetches the agent card from `inviter_url`, generates `accepting_key` for the inviter.
   - Writes friend record locally: `friends["AmazonBot"] = {url: inviter_url, ...}`. Stores `a2a:friend_key:AmazonBot = accepting_key` (their key for calling us) and `a2a:friend_outbound_key:AmazonBot = inviter_key` (our key for calling them).
   - Calls back: `POST <inviter_url>/a2a/friend-accept` with `{accepting_name, accepting_url, accepting_key}`, authenticated using `inviter_key`.
3. **Side A** receives `/a2a/friend-accept`:
   - Authenticated by the `inviter_key` from the invitation — proves the caller possesses the secret only the legitimate invitee could have.
   - Updates friend record `WebAgent.base_url = accepting_url`. Stores `a2a:friend_outbound_key:WebAgent = accepting_key`.
   - Returns `{status: "accepted"}`.

Both sides now have mutual trust + asymmetric keys, no manual key-pasting.

### Manual flow (fallback when out-of-band token isn't possible)

1. Side A: `/a2a add-friend <url> <name>` → discovers card, generates `inviter_key`, prints both keys + instructions for OOB exchange.
2. Operator manually conveys the keys.
3. Side B: `/a2a add-friend <url> <name>` followed by `/a2a set-their-key <name> <key>`.

Cumbersome but works when inviter and invitee can't easily swap a token.

### Address rotation broadcast

On every successful tunnel URL detection (boot or cloudflared restart):
1. ori2 emits `a2a:url-changed` event.
2. Listener walks `friends`, fires `POST <friend.url>/a2a/address-update` with `{sender_name: <our name>, new_base_url: <new url>}`, authenticated using the per-friend outbound key.
3. Friend's inbound `/a2a/address-update`:
   - Match priority 1: bearer key matches a stored friend's `a2a:friend_key:<name>` → update that friend's `base_url`.
   - Match priority 2: `sender_name` matches a friend's name (case-insensitive). Update.
   - Otherwise: log and ignore.
4. Failures retry with exponential backoff (5 attempts, base 15s), then give up. Log every attempt.

## DNA exchange

### Feature catalog

`data/<bot>/dna_features.json`:
```json
{
  "version": 1,
  "features": {
    "clickup-integration": {
      "description": "Create/list/comment ClickUp tasks. Verified working on AmazonBot for 30 days.",
      "files": [".pi/extensions/clickup.ts", ".pi/skills/clickup-usage/SKILL.md"],
      "tags": ["integration", "crm", "clickup"],
      "version": "1.0.0",
      "share_with": ["*"],
      "registered_at": 1713300000000,
      "registered_by": "telegram:12345"
    }
  }
}
```

Operator declares features explicitly via `register_dna_feature(id, files[], description, tags?, share_with?)`. Each feature appears in the agent card as `dna:<id>` so peers can discover.

### Wire endpoint

`GET /dna/<feature-id>.tar.gz`:
- Bearer key validated → resolves to friend name.
- Look up `feature-id`. 404 if missing.
- Check friend in feature's `share_with` (or `share_with` contains `"*"`). 403 otherwise.
- Package on the fly:
  - Re-run secret scan over the file list (defence-in-depth — files may have been edited since registration).
  - Build manifest (see below) + tarball in memory or `/tmp`.
  - Stream the response as `application/gzip`.
  - Audit: `{event: "served", feature_id, requester: <friend>, sha256, at}` to `dna_audit.jsonl`.

### Tarball manifest (inside the .tar.gz)

```json
{
  "feature_id": "clickup-integration",
  "feature_version": "1.0.0",
  "source_bot": "AmazonBot",
  "source_agent_id": "ori2-amazon-bot",
  "ori2_version": "1.0.0",
  "pi_sdk_version": "0.67.3",
  "exported_at": 1713300000000,
  "files": [
    { "path": ".pi/extensions/clickup.ts", "sha256": "...", "size": 4823 }
  ],
  "description": "...",
  "tags": ["integration", "crm", "clickup"]
}
```

### Secret scanner

Layered:
- **Regex pass**: known credential patterns (`sk-[A-Za-z0-9]{20,}`, `AIza[0-9A-Za-z_-]{35}`, `ghp_[A-Za-z0-9]{36}`, Slack `xox[baprs]-...`, generic `[A-Z_]+_(API_KEY|SECRET|TOKEN)\s*=\s*['"][^'"]+['"]`). Maintained in `src/a2a/dna_secret_patterns.ts`.
- **Entropy pass**: any string literal of length ≥ 32 with Shannon entropy > 4.5 bits/char gets flagged. Catches custom-format secrets the regex misses.
- **Filename hard refusal**: `.env*`, `vault.json`, `oauth_tokens.json`, `credentials.json`, `*.key`, `*.pem`, `id_rsa*`. No override possible.

On any flag → refuse export, print file + line + matched pattern. Operator can edit the file or `--ack-secret <hash>` to acknowledge a specific false-positive (hash of the matched line, recorded in audit log).

Re-runs on the importer side too (don't trust the sender's scan).

### Import flow (two-step)

1. **`pull_dna(friend_name, feature_id)`**:
   - GET `<friend>/dna/<feature_id>.tar.gz` with our outbound key. Size cap 10 MiB (vault `DNA_MAX_BYTES`).
   - Extract to `data/<bot>/dna_staging/<import-id>/`.
   - Re-scan secrets, verify per-file sha256 against manifest.
   - Compute conflict report: for each `manifest.files[i].path`, does `.pi/<path>` already exist? Different content?
   - Return `{import_id, manifest, conflicts: [...]}`. Does NOT touch `.pi/`.

2. **`apply_dna(import_id, strategy)`** where strategy ∈ `{abort, overwrite, rename}`:
   - Take snapshot: `cp -r .pi data/<bot>/dna_snapshots/<snapshot-id>/`. Auto-prune to last 20.
   - Copy staged files into `.pi/` per strategy. With `rename`, existing file → `<name>.local.<timestamp>.ts` before drop.
   - Run `npm test` → if fails, **automatic rollback** from snapshot. Bot stays runnable. Return `{status: "rolled-back", test_failure: <stderr>}`.
   - On test pass: prompt `/reload`. Audit-log the apply: `{event: "applied", import_id, snapshot_id, files: [...], at}`.

### Snapshot mechanism

`cp -r .pi data/<bot>/dna_snapshots/<snapshot-id>/`. ULID for snapshot-id (sortable timestamp). Auto-prune: on each apply, count existing snapshots, delete the oldest if count > 20. Manual `/dna rollback <snapshot-id>` + `/dna snapshots` for inspection.

### Default sharing — `share_with: ["*"]`

Open by default — matches the stated vision of "any ori2 copy can communicate successful evolution back to other copies."

ACL semantics on `register_dna_feature(...)`:
- No flag → `share_with: ["*"]` — every registered friend can pull.
- `--private` → `share_with: []` — no friend can pull via the endpoint. Operator can still convey the tarball out-of-band (the export is still buildable via the LLM tool, just not auto-served).
- `--share-with name1,name2` → `share_with: ["name1", "name2"]` — explicit per-friend allow list.

A friend that's not in `share_with` and `share_with` doesn't contain `"*"` gets 403 from the `/dna/<feature>` endpoint, with the error message `"feature 'X' not shared with you"`.

The secret scanner remains the floor that protects credentials regardless of ACL.

## Tunnel manager

`A2A_TUNNEL_MODE` (vault) controls behaviour:
- `cloudflared` (default): managed `cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate` child.
- `external`: skip spawn; operator sets `A2A_BASE_URL` themselves.
- `disabled`: A2A subsystem doesn't start at all.

**Cloudflared mode flow:**
1. Check `cloudflared` is on PATH; if not, log loudly with install hint, fall through to `disabled`.
2. Spawn via array-form `spawn(...)`. Pipe stdout/stderr line-by-line.
3. Match URL with `/https:\/\/[a-z0-9-]+\.trycloudflare\.com/`. First match → persist to vault `A2A_BASE_URL`, regenerate agent card on disk, emit `a2a:url-ready`.
4. Crash recovery: on non-zero exit, restart with exponential backoff (1s, 2s, 4s, ..., cap 60s). Three failures within 5min → escalate (admin DM via Telegram if available, journalctl warn otherwise) but keep retrying.
5. Graceful shutdown: SIGTERM child on bot SIGTERM/SIGINT, wait 5s, then SIGKILL.
6. URL change: if a restart picks up a new ephemeral domain, emit `a2a:url-changed` → triggers address broadcast.

## Boot order in `src/index.ts`

Insert between dispatcher startup and daemon/interactive split:

```
1. Vault load + hydrate
2. Dispatcher register CliAdapter, TelegramAdapter (no SynapseAdapter)
3. dispatcher.startAll()
4. NEW: A2A bootstrap — wrapped in try/catch, errors logged but non-fatal
   a. Read A2A_TUNNEL_MODE; if "disabled", skip
   b. Allocate local port (sticky default 8085, walk on EADDRINUSE up to +20)
   c. Load or generate A2A_API_KEY (32 hex bytes, vault)
   d. If mode="cloudflared", start tunnel.ts; await first URL match (timeout 30s — if it fails, still start the server, no public URL yet)
   e. Build agent card with detected URL
   f. Start HTTP server on allocated port, register custom middleware + routes
   g. Subscribe to "a2a:url-ready" / "a2a:url-changed" → trigger address-update broadcaster
5. Init passcode print
6. Daemon vs interactive split
```

A2A bootstrap is non-fatal: cloudflared missing, port walking exhausted, SDK init crash all log loudly, set `dispatcher.adapter("a2a").lastError`, but the rest of the bot runs. `/a2a status` for diagnosis.

## Configuration surface

| Vault key | Default | Purpose |
|---|---|---|
| `A2A_BIND_HOST` | `127.0.0.1` | Local bind (loopback only by default) |
| `A2A_BIND_PORT` | `8085`, sticky | Allocated port (auto-walks on conflict, persists actual) |
| `A2A_BASE_URL` | (detected by tunnel) | Public URL — auto-set by tunnel manager, override allowed |
| `A2A_TUNNEL_MODE` | `cloudflared` | Or `external` / `disabled` |
| `A2A_AGENT_ID` | `ori2-<bot-name>` | Identity in the network |
| `A2A_PROVIDER_NAME` | `Ori2 Project` | Optional vanity |
| `A2A_PROVIDER_URL` | (= base url) | Optional vanity |
| `A2A_API_KEY` | (generated on first boot) | OUR key — what peers must present to talk to us |
| `A2A_SKILLS_JSON` | (seed list) | Operator-overridable JSON array of additional skills |
| `DNA_MAX_BYTES` | `10485760` (10 MiB) | Cap on inbound DNA tarball size |
| `a2a:friend_key:<name>` | (per friend) | Their key for calling us |
| `a2a:friend_outbound_key:<name>` | (per friend) | Our key for calling them |

## LLM tools

All registered via `.pi/extensions/a2a.ts`, default tool ACLs as listed. `admin` includes implicit `user` access. **Every LLM tool has a corresponding slash command surface** (next section) — both produce identical state transitions on the underlying registry/catalog. The LLM tools are how the agent acts on user requests in chat; the slash commands are how the operator acts directly without going through the LLM. Operators should be able to ignore the LLM tool list entirely if they prefer the slash command UX.

| Tool | ACL | Purpose |
|---|---|---|
| `add_friend(url, name)` | admin | Manual one-side add. Generates our key, returns it for OOB sharing. |
| `accept_invitation(token)` | admin | Decode token, register inviter, callback to finalise mutual trust. |
| `list_friends()` | user | Names, URLs, last-seen, card skills. NEVER returns keys. |
| `list_friend_dna_features(friend_name)` | user | GET friend's `.well-known/agent.json`, return their `dna:*` skills. |
| `call_friend(name, message, wait?=true)` | user | Send message, return response (poll until terminal). |
| `call_agent(url, message, api_key)` | admin | One-off call to a non-friend. Testing or transient peers. |
| `cancel_friend_task(name, task_id)` | user | Abort a running task on a peer. |
| `update_friend_address(name, new_url)` | admin | Manual override (peer changed URL but didn't broadcast). |
| `broadcast_address_update()` | admin | Re-fire address broadcast manually. Auto-runs on boot. |
| `get_agent_identity()` | user | Returns OUR agent card (without API key). |
| `update_friend_key(name)` | admin | Generate a new key for this friend. Operator must convey OOB. |
| `register_dna_feature(id, files, description, tags?, share_with?)` | admin | Declare a local feature. Updates catalog + regenerates agent card. |
| `unregister_dna_feature(id)` | admin | Remove from catalog (does not delete files). |
| `list_dna_features()` | user | Our exposed catalog. |
| `pull_dna(friend_name, feature_id)` | admin | Download + stage. Returns manifest + conflict report. |
| `apply_dna(import_id, strategy?)` | admin | Apply staged import with `abort/overwrite/rename`. |
| `list_dna_imports()` | user | Staged imports awaiting apply. |
| `list_dna_snapshots()` | user | Rollback points. |
| `rollback_dna(snapshot_id)` | admin | Restore `.pi/` from a snapshot. |

## Slash commands

```
/a2a help
/a2a status                          — server state, bound port, public URL, friend count
/a2a list                            — list friends + last-seen + card skills
/a2a invite <name>                   — generate invitation token (admin)
/a2a accept <token>                  — accept an invitation (admin)
/a2a add-friend <url> <name>         — manual one-side add (admin)
/a2a set-their-key <name> <key>      — manual key set (admin)
/a2a remove-friend <name>            — drop the friend (admin)
/a2a rotate-key                      — rotate OUR API key, broadcast to all friends (admin)
/a2a broadcast-address               — re-fire address broadcast (admin)
/a2a card                            — print our current agent card

/dna help
/dna list                            — local features
/dna staged                          — incoming imports awaiting apply
/dna snapshots                       — rollback points
/dna feature add <id> <files...> [--description "..."] [--tags a,b] [--share-with name,name|*]   (admin)
/dna feature remove <id>             — (admin)
/dna inspect <id>                    — show local feature definition
/dna pull <friend> <feature-id>      — download + stage from a friend (admin)
/dna apply <import-id> [strategy]    — apply staged (admin)
/dna rollback <snapshot-id>          — restore .pi/ to snapshot (admin)
```

## Migration of existing `synapse_a2a.ts`

**Delete entirely.** No rename, no fallback. Reasoning:
- Outbound depended on `synapse` CLI (not installed in any production deployment).
- Inbound was an opt-in inbox-dir watcher nothing was writing to.
- The new A2A subsystem covers every actual use case (peer messaging, third-party agent communication).
- Removing it frees the `synapse_*` tool name space and reduces token cost on every LLM turn.
- Operators who genuinely need Synapse-spawn capability later get a clean greenfield extension built for that purpose.

Changes:
- Delete `.pi/extensions/synapse_a2a.ts`.
- Drop the `SynapseAdapter` registration from `src/index.ts`.
- The `synapse` platform identifier in the dispatcher is freed; future Synapse-spawn extension can claim it.

## Testing

### Pure-function tests (fast, hermetic)
- `src/a2a/agentCard.test.ts` — card build with various vault states, skill list auto-population, security scheme conditional rendering.
- `src/a2a/friends.test.ts` — add/remove/get/list, address rotation logic, vault key isolation, atomic-write file format, key-vs-name match priority.
- `src/a2a/dna.test.ts` — feature catalog CRUD, secret scanner regex + entropy passes, manifest validation, sha256 verification, conflict detection logic, snapshot prune.
- `src/a2a/tunnel.test.ts` — cloudflared stdout parser (feed sample lines, assert URL extracted), backoff schedule.

### Integration tests (in-process, no actual network)
- HTTP middleware: mock requests, assert auth middleware accepts/rejects correctly, custom routes resolve, JSON-RPC handler reaches the dispatcher bridge.
- DNA pack/unpack roundtrip: register a feature → simulate request → verify tarball contents → simulate import → assert files in staging match → assert apply triggers snapshot → assert rollback restores correctly.

### End-to-end smoke (manual, not in CI)
- `scripts/a2a-smoke.ts` — boots two test ori2 instances on test ports, friends them via the invitation token flow, calls a tool across them, registers + pulls + applies a DNA feature. Documented in `INSTALL.md` as "verify A2A works in your environment."

### Coverage target
- ~60+ assertions across 4 new test files
- ~3-5s additional runtime on the suite (DNA tarball roundtrips are the slowest)

## Dependencies

New runtime deps:
- `@a2a-js/sdk` (^0.3.13) — Apache-2.0, single dep (uuid). Server + client SDK from Google.

New runtime requirement (operator-installed):
- `cloudflared` binary on PATH. Optional if `A2A_TUNNEL_MODE=external` or `disabled`.

No changes to existing deps.

## Phased delivery (informational — actual plan via writing-plans skill)

Suggested commit boundaries for review-ability:

1. **Foundation:** types, agentCard.ts, friends.ts, vault keys, tests for those. Agent card buildable, friends storable, no server yet.
2. **HTTP server + middleware:** server.ts, custom routes (`/a2a/address-update`, `/a2a/friend-accept`, `/health`), auth middleware, dispatcher bridge. Server runs, peers can authenticate, messages flow into the dispatcher.
3. **Tunnel manager + boot wiring:** tunnel.ts, src/index.ts boot integration, `/a2a` slash commands, friend-related LLM tools. Full conversational A2A working end-to-end (no DNA yet).
4. **DNA exchange:** dna.ts, secret scanner, `/dna/<feature>` endpoint, feature catalog, pull/apply/snapshot/rollback flow, `/dna` slash commands, DNA LLM tools. Complete the spec.
5. **Cleanup:** delete `.pi/extensions/synapse_a2a.ts`, drop SynapseAdapter from index.ts, INSTALL.md updates documenting the Cloudflare Tunnel setup.

Each commit independently reviewable; main branch never red.
