---
name: upstream-sync
description: "Use when the operator asks about updates to the canonical upstream ori2 repo, wants to preview what has changed in the baseline since they forked, or wants to cherry-pick specific upstream commits into their detached fork. Triggers on phrases like 'any updates upstream', 'what's new in ori2', 'check for baseline changes', 'cherry-pick from original', 'sync with main ori2', 'what did I miss since I forked'."
---

# Upstream Baseline Sync

## Overview

Every Ori2 bot is **detached** from the canonical upstream at install time — a deliberate choice so self-evolution can't be clobbered by a background `git pull`. The operator controls if and when upstream changes land. This skill walks the review-and-cherry-pick flow.

## When to Use

Operator phrasing that maps to this skill:

- "any updates upstream?" / "what's new in ori2?"
- "check for baseline changes" / "sync with upstream"
- "cherry-pick `<feature/commit>` from original ori2"
- "what did I miss since I forked?"

**Do NOT use** when the operator just says "update" without qualifier — that usually means `npm install` or a restart, not upstream sync.

## Mental Model

| Artifact | Role |
|---|---|
| `.ori2-baseline` (repo root) | marker file written by `bootstrap.sh`. Records `repo=`, `branch=`, `baseline_sha=`, `cloned_at=`. |
| `scripts/sync-baseline.sh` | operator-facing entry point. Temporarily adds `ori2-upstream` remote, fetches, prints log + diff, then DROPS the remote so the bot stays detached. Never auto-merges. |
| `git cherry-pick <sha>` | how specific upstream fixes land. Operator-driven, one sha at a time. |

The bot is **detached**: `git pull origin master` pulls from the operator's own fork, not upstream. Always go through `sync-baseline.sh`.

## Workflow

### 1. Preview what's new

```bash
./scripts/sync-baseline.sh
```

Prints upstream commits since `baseline_sha` + file diff summary. Remote is dropped on exit — repo stays detached. If already at latest upstream, reports "Nothing to sync."

### 2. Decide scope (lowest → highest risk)

- **Ignore** — evolved bot is already what the operator wants.
- **Cherry-pick** specific commits — lowest risk; one fix, no unrelated drag-in.
- **Merge the whole range** — higher risk; may conflict with evolutions. Only if local changes are minimal.

### 3. Cherry-pick a commit

```bash
./scripts/sync-baseline.sh --remote          # keep remote this time
git cherry-pick <sha>                        # one sha at a time
npm test                                     # verify nothing broke
```

Conflict → resolve → `git cherry-pick --continue`.

If the commit touches anything the operator has evolved (extensions, skills, APPEND_SYSTEM), expect conflict — show them the diff and **ask** how to resolve before continuing. Never resolve conflicts on evolved files without approval.

### 4. Activate the changes

**This project runs TypeScript DIRECTLY via `tsx` — no compile step, no `dist/`, no `npm run build` script.** Pulling `.ts` files is the ONLY code update needed; activation is a matter of telling the running process to re-read them.

| What changed | How to activate | Notes |
|---|---|---|
| `.pi/extensions/*.ts` only | Call `reload_extensions` tool (chat) OR `/reload` (TUI). | Hot-reload. New tools callable on the NEXT message. No restart. |
| `src/**/*.ts` (anything else) | Restart the bot: `Ctrl+C` in the tmux pane → `./start.sh` (or `npm start`). | `src/` modules are loaded by the main process; only a fresh boot picks them up. |
| `package.json` / `package-lock.json` | `npm install` THEN restart as above. | Only when deps or scripts changed. |
| `.pi/skills/*.md`, `.pi/APPEND_SYSTEM.md`, `.pi/prompts/*` | `reload_extensions` OR `/reload`. | Pi's resource loader re-reads on reload. |
| Config only (`.env`, `data/<bot>/vault.json`) | Restart. | Env hydration happens once at boot. |

**Anti-pattern:** never suggest `npm run build`, `tsc`, or "sync dist/". Those are generic Node instincts that don't apply here — `package.json` has no `build` script and the repo has no `dist/`. Grep the scripts block if in doubt: `grep '"scripts"' package.json -A 10`.

After activation, verify by asking: did any tests run during `npm test` in step 3, and did any cherry-picked commit change a tool or command? If yes, try invoking it before reporting success.

### 5. Mark the new baseline

After a merge or cherry-pick that represents "caught up to `<sha>`":

```bash
./scripts/sync-baseline.sh --mark "$(git rev-parse HEAD)"
```

Future `sync-baseline.sh` runs report delta from THIS point forward. **Only mark AFTER commits are actually in the tree** — marking without merging lies about state.

### 6. Clean up

```bash
git remote remove ori2-upstream
```

Only needed if step 3 used `--remote`. Default (no flag) mode drops it on exit.

> Numbering note: step 4 is activation (not mark-baseline). Mark AFTER activating
> and verifying the new code works — otherwise `baseline_sha` moves forward
> while you're still on old behavior.

## Quick Reference

| Flag | Effect |
|---|---|
| (none) | fetch + print log/diff, drop remote on exit |
| `--remote` | fetch + print + KEEP remote for manual cherry-pick / merge |
| `--mark <sha>` | update `baseline_sha` to `<sha>`, record `last_synced_at` |
| `-h` / `--help` | print usage |

## Common Mistakes

- **`git pull origin master`** — pulls from operator's own fork, not upstream. Always go through `sync-baseline.sh`.
- **Merging the whole range on an evolved bot** — conflict storm. Prefer cherry-pick.
- **Skipping `--mark`** — next run re-reports the same commits as new.
- **Marking without merging** — lies about state. Mark AFTER, not before.
- **Auto-running cherry-pick / merge / mark** — operator-driven flow. Present findings, suggest commands, wait for approval before modifying history.
- **Recommending `npm run build` / `tsc` / "rebuild dist/"** — this project runs TypeScript directly via `tsx`. No build script, no `dist/`. Activation is `reload_extensions` (`.pi/` changes) or a bot restart (`src/` changes). See step 4.
- **Forgetting to activate** — pulling + cherry-picking writes new `.ts` to disk; nothing happens until reload/restart. Step 4 is not optional.

## Reporting Back

After running `sync-baseline.sh` (step 1), summarize for the operator in terse form:

- N new commits since baseline, oldest on `<date>`
- Headline titles (3-5 most relevant)
- Files touched (top 5 by line count)
- Recommendation: ignore / cherry-pick specific / merge range — with reasoning.

Wait for their decision before moving to step 3+.
