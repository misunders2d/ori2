# AGENTS.md — Development guide for agents working on ori2

> Read this FIRST whenever you open this repo in a development context.
> "Development context" includes: Claude Code editing sessions, Cursor/
> Copilot assists, the `evolution-sop` skill when Ori rewrites its own
> code, and any fork (amazon_manager, marketing_bot, …) built on this
> baseline.
>
> The rules below survive session restarts, project forks, and
> self-evolution because they live in the repo. Every dev-agent that
> follows the AGENTS.md convention (Claude Code, Copilot, Cursor, Pi's
> upwalk) reads this automatically.

---

## Project in one paragraph

ori2 is a TypeScript chat-agent framework built **on top of the Pi SDK**
(`@mariozechner/pi-coding-agent`). It adds multi-transport support
(Telegram, Slack, A2A), per-channel isolated sessions, a 3-gate security
pipeline (injection + access + tool ACL), a scheduler (cron + one-shot
reminders + self-terminating polls), peer-to-peer federation with tunnels
+ DNA exchange, and a vault/memory/health/rate-limit substrate — all
exposed to the agent as tools. It's the **baseline**. Forks for specific
verticals (Amazon seller ops, marketing, research) copy this repo and
layer domain-specific extensions on top.

## Philosophy

**Pi-native first.** If Pi provides a primitive, USE IT. If you find
yourself writing something that feels like Pi should already have it,
stop and check. Prior audits (see `docs/pi-alignment-plan.md`) deleted
~300 LoC of code that duplicated Pi — don't add it back.

**Verify, don't assume.** Pi's docs at
`node_modules/@mariozechner/pi-coding-agent/docs/*.md` are the reference
for API shape. Docs can elide runtime details — when in doubt, grep
`node_modules/@mariozechner/pi-coding-agent/dist/` for the actual
implementation. Past incidents:
- Assumed `SessionManager.create(dir)` put files under `dir` — actually
  takes `(cwd, sessionDir?)`, first arg is just the session-header cwd.
- Assumed `ReadonlySessionManager` was a real runtime type — actually a
  compile-time `Pick<>`; runtime object is full SessionManager.
- Assumed the 🫀 emoji was safe in logs — Node's test-runner IPC
  deserializes with structuredClone and chokes on higher-plane UTF-8.

**Language-neutral everything user-facing.** Never regex-match natural-
language user intent (cancel, stop, confirm, etc.) — users speak many
languages; such a regex excludes Russian/Ukrainian/Spanish/German
speakers. Delegate intent classification to the LLM. Regex is OK for
**structural commands** (`/init`, `!plan-abort`, `ACT-XXXXXX`), never
for conversational phrases.

**Baseline vs fork scope.** Baseline = primitives that every fork needs
(kvCache, attachments, schedule_poll, A2A, tunnels, guardrails, scheduler).
Fork = tools that call APIs the baseline doesn't need (SP-API wrappers,
cloud CLIs, DuckDB, exceljs, etc.). When in doubt, it's fork-scope.

## Architecture quick-map

```
src/
  core/           — primitives (vault, memory, whitelist, toolAcl, kvCache,
                    channelSessions, channelModels, health, errorLog,
                    heartbeat, singletons, rateLimiter, staging, ...)
  transport/      — adapters + dispatcher + channelRouter + media
  a2a/            — peer federation (server, client, adapter, friends,
                    tunnel, dna, invitations, keyRotation, ...)
  onboarding/     — first-run wizard (setup.ts writes vault+auth.json)
  security/       — pinned pipeline test
  index.ts        — bootstrap (daemon + interactive modes)

.pi/
  APPEND_SYSTEM.md           — runtime directives every agent turn sees
  extensions/*.ts            — agent-loadable tools + hooks + commands
  skills/<name>/SKILL.md     — triggered skills for specific tasks
  prompts/                   — slash-command templates

systemd/ori2.service         — per-bot user-unit template
.github/workflows/test.yml   — CI (tsc + tests on Node 22/24)
scripts/                     — operator tools (a2a-smoke, prewarm, ...)
```

**Extensions are the main extension point.** Anything the agent should
be able to DO is an extension registering tools/commands/hooks. Anything
cross-cutting (vault, memory, rate limiter) is `src/core/` that
extensions import.

## Hard rules (non-negotiable)

These are pinned by `src/security/pipeline.test.ts` and
`src/arch/invariants.test.ts`. Violations fail CI.

1. **Every new extension MUST cite its Pi-API source.** A comment
   referencing the docs file + line number where the API is documented.
   Example: `// Per docs/extensions.md §pi.on("tool_call") line 562`.

2. **No shell-invoking process spawn with string interpolation of user
   input.** Use the argv form of `spawn()` or the promisified `execFile`
   — no template strings concatenated into a single shell command.
   The `tdd_enforcer.ts` fix (§7.5 in the alignment plan) is the canonical
   example.

3. **No English-only intent regex.** Forbidden patterns include
   `/cancel|stop|abort|nevermind/i`, `/yes|no|ok/i`, and similar. Structural
   command prefixes (`^\s*!plan-abort`, `^\s*/init\s`) are fine.

4. **Every singleton MUST use `getOrCreate()` from `src/core/singletons.ts`.**
   Module-local `let _instance: X | null = null` patterns are banned —
   Pi's jiti + tsx load extensions in separate module graphs (Phase 6
   of the alignment plan documents this). Silently wrong; hard to debug.

5. **Every subprocess spawn of `pi -p` MUST pass
   `ORI2_SCHEDULER_SUBPROCESS=1` in env.** Without it, the child's
   scheduler extension rehydrates the parent's jobs dir and can double-fire.

6. **Pinned tests MUST NOT be skipped.** `src/security/pipeline.test.ts`
   and `src/arch/invariants.test.ts` are the contract. No `.skip`, no
   `it.todo`, no env gate. If behavior legitimately changes, update the
   test in the same commit.

7. **Secrets never leave the vault.** No console.log of
   `process.env.*_KEY`, no passing credentials as tool-call arguments
   that flow into LLM context, no committing `.env` / `data/<bot>/`
   files. The guardrails extension and `src/a2a/secretScanner.ts` exist
   specifically for this.

8. **Cross-process state uses kvCache, not filesystem JSON.** Reach for
   `getKVCache().get(ns, key)` / `.set(ns, key, value, ttlSec?)` before
   inventing another data/<bot>/foo.json. Exceptions: per-bot structural
   data that predates kvCache (vault.json, whitelist.json,
   channel-sessions.json) — don't migrate without a reason; do NEW
   transient state through kvCache.

## Development workflow

### Before writing code

1. **Read the relevant Pi docs** at
   `node_modules/@mariozechner/pi-coding-agent/docs/*.md`. The file to
   start with depends on task; `extensions.md` for tool/hook authoring,
   `session.md` for anything session-related, `providers.md` for auth.
2. **Grep `dist/` for the actual API shape** if docs are ambiguous —
   argument order, lazy-vs-eager writes, default paths, etc.
3. **Search for existing patterns** in this repo — if we have three
   extensions that do something similar, reuse that pattern rather
   than inventing a fourth style.
4. **Consult `.pi/skills/adding-capabilities/SKILL.md`** for the approved
   tool-authoring flow.

### Making changes

1. Run `npx tsc --noEmit` + `npm test` **locally, before pushing**. CI
   will fail otherwise; catch it locally.
2. Add a test for any new behavior. If the new behavior is architecturally
   important, add a pinned assertion to `src/arch/invariants.test.ts`.
3. Follow the existing commit-message style — imperative subject, wrapped
   body, references to files/lines, no marketing speak.
4. Co-authorship trailers for AI assistance:
   `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

### When Ori evolves itself

The runtime agent rewriting its own code is covered by the
`evolution-sop` skill at `.pi/skills/evolution-sop/SKILL.md`. That skill
walks through the safe edit-test-commit-reload cycle. When the agent is
about to modify a file under `.pi/extensions/` or `src/`, it loads this
AGENTS.md + the evolution-sop skill and applies BOTH sets of rules.

## Anti-patterns (with real-world references)

### Don't re-invent Pi

Bad: building a custom env-hydration layer and setting `GOOGLE_API_KEY`
when Pi's provider resolver actually reads `GEMINI_API_KEY`, and
`auth.json` wins over env vars anyway (see §7.1 of pi-alignment-plan.md).

Good: seed Pi's `auth.json` at onboarding via `writePiAuthJson({ google:
geminiApiKey })`, let Pi resolve normally.

### Don't hardcode English intent

Bad: a regex like `/^(cancel|stop|abort|nevermind)$/i.test(msg.text)` —
silently excludes every non-English speaker.

Good: route the message to the agent and let the model interpret intent.
One LLM turn of overhead to be language-correct is a cheap trade.

### Don't use templated shell commands

Bad: spawning a shell with string-interpolated user input — backticks,
`$()`, newlines in the interpolated value will escape the quoting and
potentially run arbitrary commands.

Good: use the argv form — pass the command and its args as separate
parameters so the shell never sees the user input as shell syntax.
`spawn("git", ["commit", "-m", msg])` is the canonical fix pattern.

### Don't bypass the singleton registry

Bad: `let _vault: Vault | null = null;` at module scope. Pi's jiti and
tsx load modules in separate graphs; two separate `_vault` variables
spring into existence and silently diverge.

Good: `getOrCreate("vault", () => new Vault())` — cross-graph singleton
via `globalThis`. See Phase 6 of the alignment plan.

### Don't write to the session file bypassing AgentSession

Bad: opening a fresh SessionManager on disk and calling
`appendCustomMessageEntry` — the entry persists but the live TUI doesn't
observe the write. User sees nothing even though the file has the entry.

Good: `pi.sendMessage({ customType, content, display: true }, {
triggerTurn: false })` — routes through AgentSession's event stream; TUI
rerenders.

## Where to find things

| Need | File |
|---|---|
| Adding a new tool | `.pi/skills/adding-capabilities/SKILL.md` |
| Safe self-evolution flow | `.pi/skills/evolution-sop/SKILL.md` |
| Pi-API alignment history (what was de-duplicated and why) | `docs/pi-alignment-plan.md` |
| Security pipeline guarantees | `src/security/pipeline.test.ts` |
| Architectural invariants | `src/arch/invariants.test.ts` |
| Per-channel session routing | `src/transport/channelRouter.ts` + `src/core/channelSessions.ts` |
| Scheduler jobs + polls | `.pi/extensions/scheduler.ts` |
| A2A peer federation | `src/a2a/*.ts` |
| First-run wizard | `src/onboarding/setup.ts` |
| Health aggregator | `src/core/health.ts` |
| Log aggregation sink (future) | `src/core/logSink.ts` |

## Testing discipline

- `npm test` runs every `src/**/*.test.ts` via Node's native test runner.
- **No** `.skip`, no `it.todo`, no env-gated disables on pinned tests.
- Tests that spawn real processes or bind real ports must clean up in
  `afterEach` — otherwise node:test's worker IPC can hang or fail to
  deserialize (a real bug caught on 2026-04-17: the `🫀` emoji in a
  log line corrupted the IPC frame).
- Tests use a unique `BOT_NAME` at file top
  (`process.env["BOT_NAME"] = "_test_…"`) to isolate data dirs.

## Dependencies

- Node ≥ 22 (LTS). Both 22 and 24 in CI matrix.
- `@mariozechner/pi-coding-agent` is pinned. Do NOT update without a
  rerun of the full alignment audit — Pi's internal APIs (session
  shape, extension context) change and previously-stable code can break.
- `better-sqlite3`, `fastembed`, `express` are all production deps —
  adding new production deps needs justification (bundle size, license,
  maintenance).

## Evolution trajectory

This project is the **baseline** for multiple forks:
- amazon_manager (SP-API / Keepa / Helium10 / BigQuery seller ops).
- marketing_bot (future; email / social / content pipelines).
- orchestrator (future; provisions VPSes and manages peer agents).

When an evolution extends the baseline in a way forks will need, **propose
it for baseline** rather than fork-specific. The three baseline additions
landed 2026-04-17 (`kvCache`, `attachments`, `schedule_poll`) are examples
of this.

When an evolution is clearly domain-specific (cloud CLI wrappers, Amazon
SP-API, DuckDB queries, exceljs exports), it's **fork-scope**. Commit it
to the fork, not here.

## If this file contradicts something else

- `.pi/APPEND_SYSTEM.md` takes precedence for **runtime** rules (security,
  credentials, operational safety).
- This file takes precedence for **development** rules (architecture, code
  style, Pi-native philosophy).
- `.pi/skills/evolution-sop/SKILL.md` takes precedence when Ori is
  self-modifying.
- If you find a real conflict, update BOTH files in the same commit to
  keep them consistent.
