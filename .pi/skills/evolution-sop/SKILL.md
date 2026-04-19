---
name: evolution-sop
description: "Use this skill WHENEVER the user asks you to 'evolve', 'build a new feature', 'add an integration', 'create a tool', or modify the platform's core code."
---

# Secure Platform Evolution (Standard Operating Procedure)

You are tasked with "evolving" the platform for a user who relies on you completely. **You are strictly forbidden from "cowboy coding"**. Act as a Senior Security Engineer and follow this rigid 6-Phase framework.

**Do not skip steps.** Two of the phases (1 and 2) are ENFORCED by `verify_and_commit` — the commit tool REFUSES to commit if the corresponding session entries aren't present. Skipping them wastes everyone's time because you'll be blocked at the end.

---

## Phase 1: Safety-First Briefing (ENFORCED GATE)

**Before ANY code, ANY searches, ANY writes:** stop, think, and brief the user.

### 1a. Enumerate concrete risks for THIS evolution

Not boilerplate. Specific to what they asked. Cover (at least) these categories when relevant:

- **Credentials** — will this need an API key / OAuth token / bearer? How will it be stored (`/credentials add`, `/oauth connect`) so it never enters your context? How will it be retrieved at call-time?
- **Prompt injection** — does the new tool fetch external content (web, 3rd-party API responses, user-supplied text)? That content will flow back into your context and is attack surface. What's the plan (guardrails `tool_result` hook handles indirect injection on web/bash/read — confirm it will also cover this new tool's output)?
- **Data exfiltration** — what outbound requests will the new code make? To which domains? Can a malicious prompt redirect those outbound calls?
- **Filesystem writes** — will the code write anywhere? Does `secret_files_guard` already cover the paths you'll touch? Will you stay inside `data/<bot>/` or outside it?
- **Supply-chain** — new npm dependencies? (Use `secure_npm_install`, not bash.) Any packages under 14 days old → auto-blocked. Any transitive deps you should flag?

### 1b. Propose a concrete mitigation for every risk

Not "we'll be careful." A specific code-level mitigation that a reviewer can verify.

### 1c. Post the briefing to the user in chat

Structured, terse, copy-pasteable format:

```
## Safety briefing — <domain>

RISKS:
  1. <category>: <specific-to-this-evo>    → mitigation: <how-code-prevents-it>
  2. ...

TO PROCEED: please reply `confirm safe evolution` (or specify changes you want first).
```

### 1d. WAIT for the user's explicit reply

If they say confirm / proceed / yes / ok / go → acknowledged.
If they push back, list concerns, or ask for changes → iterate. Do NOT proceed until you see explicit affirmative consent.

### 1e. Call `evolve_safety_ack`

```
evolve_safety_ack({
    domain: "<name>",
    risks_enumerated: [<same structured list you showed the user>],
    briefing_shown_to_user: "<verbatim text of what you posted>",
    user_acknowledged: true,        // ← ONLY if they actually replied to confirm
    user_reply_quote: "<their exact reply>"
})
```

**Do NOT set `user_acknowledged: true` without a real user confirmation.** Fabricating acknowledgement is the single most serious safety-gate violation.

---

## Phase 2: Prior Art Search (ENFORCED GATE)

Before writing, check if somebody has already solved this. Most evolutions are adaptation of prior work, not ground-up invention.

### 2a. Three mandatory searches

1. **Pi's own examples.** Fetch / read:
   - `node_modules/@mariozechner/pi-coding-agent/docs/` (in this repo)
   - `https://github.com/badlogic/pi-mono/tree/main/examples/extensions` via `web_fetch`

   Look for extensions that demonstrate the pattern you need (subagent for long-running sub-tasks, protected-paths for write gating, etc.).

2. **GitHub code search.** Use `web_search` / `web_fetch`:
   - `"pi.registerTool" <domain-keyword>` site:github.com
   - `"@mariozechner/pi-coding-agent" <domain>` site:github.com
   - `<domain> pi extension` site:github.com

   Document the queries you ran AND the relevant hits (URLs). Zero-hit searches are valid findings — record them too.

3. **Domain SDK docs.** For 3rd-party APIs (Pinecone, SendGrid, ClickUp, etc.), fetch the official Node SDK docs via `web_fetch` and confirm the API shape you'll consume.

### 2b. Present findings to the user

Summarize: what prior art exists, what you'll reuse vs adapt vs build fresh, and why.

### 2c. Call `evolution_prior_art_search`

```
evolution_prior_art_search({
    domain: "<name>",           // same as safety-ack domain
    pi_examples_checked: [...],
    github_searches_performed: [
        { query: "...", relevant_hits: ["url1", "url2"] },
        ...
    ],
    sdk_docs_reviewed: ["https://..."],
    conclusion: "adapt-existing: <reasoning>" | "partial-reuse: ..." | "build-fresh: <why nothing existed>"
})
```

---

## Phase 3: Secure Dependency Management

Installing a new npm package:

1. You are **blocked from `bash npm install`** by `npm_security`. Do not try.
2. Use the `secure_npm_install` tool.
3. It auto-rejects deprecated / <14-day-old / CVE-flagged packages. If it aborts, read the error — typosquats and malware are its primary targets.

---

## Phase 4: Secure Scaffolding

Writing code (Pi's `write` / `edit` tools):

1. **Never hardcode secrets.** Read them via the credentials / OAuth APIs at call-time.
2. **Never log secrets.** Check every `console.log` before committing. Outbound tool outputs are redacted at the `tool_result` boundary — but your code should never emit them in the first place.
3. **Respect isolation.** Bot-specific files land under `data/<bot>/`. Shared package code goes elsewhere.
4. **Follow anti-patterns.** Read `.pi/extensions/guardrail_corpus.json` + secret-scanning filename rules. Don't give a tool a name that matches one of the hard-forbidden patterns.

---

## Phase 5: Test-Driven Development (TDD)

Strict TDD directive:

1. Before finalizing, write a `.test.ts` under `src/` (NEVER under `.pi/extensions/` — the loadability invariant test will fail).
2. The test MUST cover the security edge cases from Phase 1 (malformed inputs rejected, auth enforced, redaction verified, etc.).
3. Add positive-path tests too, but security cases are non-negotiable.

---

## Phase 6: Verify & Commit (ALL FOUR GATES)

Call `verify_and_commit({ commit_message: "..." })`. It runs four gates, in order:

1. **Evolution-sop discipline** — `evolution_prior_art_search` + `evolve_safety_ack` entries present? `user_acknowledged=true`?
2. **Secret scan on staged diff** — any leaked API keys / bearer tokens / private keys / entropy-heavy strings?
3. **Full test suite** — `npm test`.
4. **Commit + push** (push best-effort).

If ANY gate fails, the tool returns a specific remedy. Fix the issue and re-run. Do not tell the user "I'm done" until the tool returns success.

After a successful commit, inform the user:
- What was added (1-line summary).
- If they need to add any new env keys / credentials outside the ones already handled.
- To activate the new tools in the live session:
  - **From chat (Telegram/Slack/A2A):** call the `reload_extensions` tool (admin-only).
  - **From the TUI:** type `/reload` directly.
  - **src-level changes** (outside `.pi/`): need a full process restart; neither reload path covers them.

---

## Red flags — if you're thinking these, STOP

| Thought | Reality |
|---|---|
| "This is a simple tweak, I'll skip Phase 1." | verify_and_commit will refuse the commit. Do Phase 1. |
| "I'll set `user_acknowledged: true`, the user will probably be fine with it." | Never. That's the single most serious safety violation. |
| "Prior art search is overkill for this domain." | Do it anyway. It's 3 fetches. Finding zero hits is a valid finding. |
| "I'll run `npm install` in bash real quick." | You're blocked. Use `secure_npm_install`. |
| "I'll write the test later after the code works." | The gate runs tests at commit time. Write the test first, or you'll just refactor it later under pressure. |
