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

### 4. Mark the new baseline

After a merge or cherry-pick that represents "caught up to `<sha>`":

```bash
./scripts/sync-baseline.sh --mark "$(git rev-parse HEAD)"
```

Future `sync-baseline.sh` runs report delta from THIS point forward. **Only mark AFTER commits are actually in the tree** — marking without merging lies about state.

### 5. Clean up

```bash
git remote remove ori2-upstream
```

Only needed if step 3 used `--remote`. Default (no flag) mode drops it on exit.

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

## Reporting Back

After running `sync-baseline.sh` (step 1), summarize for the operator in terse form:

- N new commits since baseline, oldest on `<date>`
- Headline titles (3-5 most relevant)
- Files touched (top 5 by line count)
- Recommendation: ignore / cherry-pick specific / merge range — with reasoning.

Wait for their decision before moving to step 3+.
