---
name: pi-ecosystem-prior-art
description: "Use before writing OR modifying ANY code that touches Pi SDK internals — session state, AgentSession events, LLM-context building, channel/adapter plumbing, custom-message entries, compaction, scheduling, cross-channel delivery. Applies to NEW features (evolution-sop Phase 2) AND bugfixes/refactors on existing extensions. Also applies before calling any `session.*` / `sessionManager.*` / `pi.*` API — grep the Pi SDK `.d.ts` files for higher-level methods before reaching for lower-level primitives (e.g. `sendCustomMessage` over `appendCustomMessageEntry`). The Pi SDK ecosystem (bundled examples + badlogic/* + openclaw/*) has canonical implementations for most patterns ori2 will ever need."
---

# Pi Ecosystem Prior-Art Index

**Purpose:** the Pi SDK ecosystem has canonical, maintained implementations for nearly every pattern ori2 is likely to evolve — channel adapters, sandbox execution, image generation, custom compaction, plan-mode, dynamic tools, file-trigger automation, custom LLM providers. **Check here FIRST** before a fresh WebSearch. Reinventing a wheel the author of Pi already built is a failure mode we've hit repeatedly.

## Pi SDK self-check (do this BEFORE any Pi-API call, in new code OR bugfixes)

Before using any `session.*`, `sessionManager.*`, `pi.*` method, grep Pi's own `.d.ts` files for related names — higher-level API methods that bundle state updates almost always exist next to the lower-level primitives. Missing them is how we ship bugs like "scheduler-delivery persisted to branch but invisible to the next LLM turn" (the fix was `session.sendCustomMessage({triggerTurn: false})`, which updates BOTH `agent.state.messages` AND the SessionManager — `sessionManager.appendCustomMessageEntry` alone only does the latter).

One-liner that surfaces related methods every time:

```bash
# What API lives near this concept? Run BEFORE writing any Pi-API call.
grep -rn "<concept>" node_modules/@mariozechner/pi-coding-agent/dist/core/*.d.ts \
  | grep -v "\.d\.ts\.map"
```

Concrete examples:

| I was about to call… | Better alternative you'd find by grepping | Why |
|---|---|---|
| `sessionManager.appendCustomMessageEntry(...)` | `session.sendCustomMessage({...}, { triggerTurn: false })` | Updates `agent.state.messages` (the actual LLM-context array) in addition to persistence. |
| `session.subscribe(...)` polling for agent_end | `session.prompt(text, {...})` already awaits turn completion | Subscribe only when you need event-driven delivery; for sequential flow, prompt resolves when done. |
| manual child_process `spawn("git", ...)` with URL-embedded token | `credentials_git` tool (ori2) — injects auth via `GIT_CONFIG_*` env | Keeps the token off argv and off `.git/config`. |

**Before any Pi-API call in new or existing code, run the grep above.** If you find a higher-level method that already does the thing you're piecing together, use it and stop.

Red flag — STOP if any of these apply:
- You're writing "Pi doesn't have an API for this, let me do it via lower-level primitives…" without having grepped the `.d.ts` files for related names.
- You're about to `sessionManager.append…` from outside the AgentSession — grep for `session.send…`/`session.push…` variants first.
- You're about to `spawn` a process to do something Pi has a tool for. Check `pi.registerTool` callsites in `pi-coding-agent/examples/` for the tool shape.

## When to Use

- **ALWAYS** as the first action inside evolution-sop Phase 2a (prior-art search). Before running any WebSearch/WebFetch on GitHub — scan this index first.
- Before writing any new extension in `.pi/extensions/` — if a bundled example covers the pattern, adapt it rather than inventing.
- Before writing a new transport adapter (Slack, Discord, Teams, WhatsApp) — `badlogic/pi-mom` (Slack) and `badlogic/pi-telegram` are reference bridges.
- When user asks for a file-producing capability (image gen, chart gen, file export) — Pi's `antigravity-image-gen.ts` plus the `attach_file` tool (already in ori2) is the pattern.
- When a feature you're about to build matches a name on this page — **read the referenced file/repo before writing**.

## Local bundled examples

All paths relative to the repo root. These come with every `npm install` — no network needed.

```
node_modules/@mariozechner/pi-coding-agent/examples/
├── extensions/                   # The canonical reference for how each pattern should be written
└── sdk/                          # Minimal SDK-embedding examples (01-minimal through 13-session-runtime)
```

### Most directly relevant to ori2's roadmap

| If you're about to build… | Read first | Notes |
|---|---|---|
| Bash sandbox (the deferred audit item) | `extensions/sandbox/` | bwrap / firejail. Adopt this instead of rolling our own. |
| A subagent/subprocess runner | `extensions/subagent/` | Multiple agent.md files + dispatcher. ori2 already follows this; keep in sync. |
| Plan-mode enforcement | `extensions/plan-mode/` | Compare to our `plan_enforcer.ts`. |
| Path-level deny / permission gate | `extensions/protected-paths.ts`, `extensions/permission-gate.ts` | Compare to our `secret_files_guard.ts`, `admin_gate.ts`. |
| Session hand-off | `extensions/handoff.ts` | Compare to our `session_handoff.ts`. |
| Custom compaction strategy | `extensions/custom-compaction.ts` | Hook into Pi's compaction loop. |
| Add/remove tools at runtime | `extensions/dynamic-tools.ts` | Relevant for evolution workflows. |
| Add/remove context files at runtime | `extensions/dynamic-resources/` | Relevant for evolution workflows. |
| Image generation tool | `extensions/antigravity-image-gen.ts` | Pair with ori2's `attach_file` for delivery. |
| Cross-extension event bus | `extensions/event-bus.ts` | Cleaner than ad-hoc `pi.events.emit`. |
| Pre-bash interception | `extensions/bash-spawn-hook.ts` | |
| File-watcher → action | `extensions/file-trigger.ts` | For filesystem-driven automation. |
| Confirm on destructive action | `extensions/confirm-destructive.ts` | Per-tool confirmation pattern. |
| Auto-commit on clean exit | `extensions/auto-commit-on-exit.ts` | Git-checkpoint style. |
| Custom LLM provider | `extensions/custom-provider-anthropic/`, `extensions/custom-provider-qwen-cli/`, `extensions/custom-provider-gitlab-duo/` | Template + plumbing. |
| Input rewriting / transforms | `extensions/input-transform.ts` | |
| Desktop notifications | `extensions/notify.ts` | |
| Dirty-repo guard | `extensions/dirty-repo-guard.ts` | |
| Claude-style system rules | `extensions/claude-rules.ts` | Project-rules-file pattern. |

If your feature name matches a filename above, **read that file before writing a single line**.

## GitHub repos (via `gh api` or `gh repo clone`)

Use `gh api repos/<owner>/<repo>/contents/<file>` to fetch raw files without cloning — all of these are open-source.

### Transport bridges (direct blueprints for ori2's Slack/Discord/Teams roadmap)

| Repo | What it is | Use for |
|---|---|---|
| `badlogic/pi-telegram` | Reference Telegram DM bridge for Pi. Single 1100-line file. | Already cribbed for our inbound multimodal + `attach_file` contract. Re-read before touching the Telegram adapter. |
| `badlogic/pi-mom` | Reference Slack bot for Pi — Socket Mode, per-channel isolation, attachment handling. | **Blueprint for the Slack adapter roadmap item.** Don't invent — adapt this. |
| `openclaw/openclaw` | Full multi-channel routing framework (WhatsApp / Telegram / Slack / Discord / Signal / iMessage / many more) built on Pi. | If we ever want to support >3 transports, study OpenClaw's abstraction boundary before adding another one-off adapter. |

### SDKs & infrastructure

| Repo | Notes |
|---|---|
| `badlogic/pi-mono` | The Pi monorepo: TUI/WebUI libs, vLLM pods, the Slack bot. Source of truth for Pi internals. |
| `badlogic/lemmy` | Tool-using LLM wrapper at a lower layer than Pi. Useful if you're rolling a custom agent loop. |
| `badlogic/pi-skills` | Skills collection (Pi-native, also Claude Code and Codex compatible). Check here for skills before writing a new one. |
| `openclaw/acpx` | Stateful Agent Client Protocol (ACP) sessions — relevant if ori2 ever needs an external agent client connecting to the bot. |
| `openclaw/lobster` | Workflow shell — typed macro engine for composable pipelines across skills/tools. |
| `openclaw/clawhub` | Skill directory / registry pattern. |

## Quick retrieval recipes

```bash
# Peek the index of a bundled example
ls node_modules/@mariozechner/pi-coding-agent/examples/extensions/

# Read one
head -80 node_modules/@mariozechner/pi-coding-agent/examples/extensions/sandbox/index.ts

# Fetch a single file from a GitHub repo without cloning
gh api repos/badlogic/pi-mom/contents/index.ts --jq .content | base64 -d

# List a repo's top-level contents
gh api repos/badlogic/pi-telegram/contents | jq '.[].name'
```

## Protocol when you find a match — "best of both worlds"

The Pi ecosystem gives you **canonical shape**: correct API use, hook selection, data flow, event ordering, edge-case coverage the author of Pi already thought through. What Pi examples do **not** give you: ori2's security model. Most Pi examples are intentionally minimal proof-of-concepts — single-user, trusted environment, no role ACL, no staging, no cross-transport abstraction.

**The rule: take the shape from Pi; keep the hardening from ori2. Never regress to Pi's simpler PoC style just because your feature looks like theirs.**

### Checklist every time you port a Pi pattern

1. **Read the reference in full.** Don't skim.
2. **Copy the shape.** Which hook (`before_agent_start` vs `tool_call` vs `agent_end`)? Which Pi APIs (`pi.registerTool`, `ctx.sessionManager.appendCustomEntry`, `session.prompt` with `options.images`)? What's the event ordering? Which edge cases does the Pi code handle? Those decisions are already correct — don't second-guess them.
3. **Add ori2's security layers on top.** For every new tool/adapter/extension, verify:
   - [ ] **Role ACL.** Does `tool_acl.json` have a sensible default (baseline: admin + user roles that match the threat model)? Operator can tighten via `alwaysConfirm` / `requiredRoles`.
   - [ ] **Admin staging.** Does the tool need `alwaysConfirm` for destructive operations? (See `confirm-destructive.ts` pattern + ori2's policy engine.)
   - [ ] **Secret-path denial.** If paths are accepted, does it consult `src/core/secretFilesDeny.containsSensitivePath`? Is the tool's arg shape covered by `secret_files_guard`'s `PATH_ARG_TOOLS` / `PATH_ARRAY_ARG_TOOLS` table?
   - [ ] **Pre-LLM guardrail.** If the tool feeds text into Pi's context (from external APIs, user files, web fetches), is the content run through `checkTextForInjection` from `guardrails.ts`? Tag rather than block if legitimate-but-risky, per `doPassiveContext`'s pattern.
   - [ ] **Transport-origin attribution.** If the tool acts on behalf of a chat user, does it pull origin via `currentOrigin(ctx.sessionManager)`? Enforces the "who is talking right now" invariant required for admin_gate / memory attribution / per-channel queues.
   - [ ] **Secret redaction.** Does any tool output touch env/vault values? The `tool_result` boundary redactor runs automatically — but don't emit them in the first place.
   - [ ] **Audit trail.** Does `channelLog` capture inbound? Does `secretAccessLog` record reads of vault/credential/oauth entries?
4. **Never strip security to match Pi's style.** If Pi's `protected-paths.ts` is a simple substring check, that's because it's a demo. ori2's `secret_files_guard` is deliberately more defensive — cross-bot probes, pattern-arg tools, bash inspection. Keep the layers.
5. **Cite the reference in Phase 2.** Pass file path or GitHub URL in `pi_examples_checked` / `github_searches_performed` when calling `evolution_prior_art_search`.

### Red flag: "the Pi example doesn't do X, so we don't need X either"

No. The Pi example doesn't do role ACL because it's running in a trusted single-user REPL. ori2 runs in multi-user group chats where anyone you whitelist can invoke any non-admin tool. Security features that Pi can skip, ori2 cannot.

## Red flags — STOP

| Thought | Reality |
|---|---|
| "My feature is too specific for the Pi ecosystem." | 90% of what ori2 does has a canonical Pi analog. Check before committing to that assumption. |
| "The Pi example doesn't have our security model." | That's expected — ori2 layers on top. The Pi example still shows the correct HOOK / API / event shape. |
| "I'll WebSearch first, then check examples." | Reverse that. Local examples are instant + authoritative; WebSearch is a fallback. |
| "I already know what the example does." | Re-read anyway. The Pi SDK evolves faster than our memory of it. |

## Audit of ori2 extensions vs Pi examples (2026-04-19)

An audit compared every existing ori2 extension against its closest Pi example. **Verdict: no reinvention problem in the extensions.** Divergences are either deliberately hardened for ori2's multi-user production model, or solve problems the Pi example doesn't address. This is the map of what-matches-what so you don't "refactor to match" something that's intentionally different.

| ori2 file | Closest Pi example | Verdict |
|---|---|---|
| `plan_enforcer.ts` | `plan-mode/` | **Orthogonal.** Pi's is read-only exploration mode (restricts tools). Ours is deterministic sequential step-locking for scheduled autonomous runs. Different domain — don't merge. |
| `tdd_enforcer.ts` | `auto-commit-on-exit.ts` | **Intentionally stricter.** Pi auto-commits from the last assistant message (loose). Ours runs 4 gates (prior-art / safety-ack / secret-scan / test-suite). Don't soften. |
| `evolution_guards.ts` | `confirm-destructive.ts` | **Different layer.** Pi gates session operations (clear, fork). Ours records structured tool outputs that `verify_and_commit` consumes. Keep. |
| `secret_files_guard.ts` | `protected-paths.ts` | **Intentionally harder.** Pi does substring on a hardcoded list (`.env`, `.git/`, `node_modules/`). Ours does resolved-path checks against `botDir()`, substring denial, per-field validation for path-array tools, pattern blocking (find/grep), bash command inspection. Catches cross-bot probes Pi's version misses. **Don't simplify.** |
| `admin_gate.ts` | `permission-gate.ts` | **Intentionally bigger.** Pi is a PoC regex on bash (rm -rf, sudo, chmod). Ours is full authn/authz: whitelist/blacklist + role ACL + `tool_acl.json` policy + TOTP + staging + audit trail + `/init` passcode. Production scope. |
| `session_handoff.ts` | `handoff.ts` | **Note for later.** Pi uses an on-demand LLM call to synthesize a focused prompt; user edits; new session spawned with `parentSession` tracking. Ours is passive side-channel file injection (simpler, no extra LLM call). Consider offering both modes as a future evolution. |
| `evolve.ts` | `dynamic-tools.ts` | **Orthogonal.** Ours is discoverability + git-diff surface. Pi's is tool (un)registration at runtime. Both valid, different jobs. |

### Where we HAVE reinvented (fixed in commit 7b7e2c2)

The media flow. `pi-telegram` had the full canonical pattern since day one; we dropped `msg.attachments` in the f69bb81 subprocess→in-process rewrite and spent a week debugging "files don't work." Fixed cases:
- **Inbound multimodal:** `ImageContent[]` via `options.images` + text-inline extracted content → `createTelegramTurn` in `pi-telegram/index.ts`.
- **Outbound file delivery:** `attach_file` tool + per-channel queue + drain on `agent_end` → direct generalization of pi-telegram's `telegram_attach` made cross-transport.
- **Media-group buffering:** 1200ms `media_group_id` debounce — exact value from pi-telegram.

### Deferred for future consideration

- **Bash sandbox** (`extensions/sandbox/`). Uses `@anthropic-ai/sandbox-runtime` (bwrap on Linux, sandbox-exec on macOS). ori2's audit deferred this under `alwaysConfirm` gating — reasonable in interactive use. Revisit if we move heavily into scheduled/non-interactive execution where human confirmation isn't always in the loop.

## Takeaway

The existing extensions were **not** where reinvention happened. The **transport layer** was — specifically anywhere `msg.attachments` or `response.attachments` crosses a boundary. Before touching transport/adapter/channelRuntime code again, re-read `pi-telegram/index.ts` and the pi-mom Slack-bot source for the canonical shape. For the hardened extensions (admin_gate, secret_files_guard, tdd_enforcer), Pi's examples are starter code — keep ori2's hardened versions.
