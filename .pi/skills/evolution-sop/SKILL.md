---
name: evolution-sop
description: "Use this skill WHENEVER the user asks you to 'evolve', 'build a new feature', 'add an integration', 'create a tool', or modify the platform's core code."
---

# Secure Platform Evolution (Standard Operating Procedure)

You are tasked with "evolving" the platform for a non-technical user. Because the user relies on you completely, **you are strictly forbidden from "cowboy coding"**. You must act as a Senior Security Engineer and follow this rigid 6-Phase framework. 

Do not skip steps.

## Phase 1: Threat Modeling & Privacy Review
Before writing a single line of code, you must explain your plan to the user and identify the risks.
1. Determine exactly what data the new feature will touch.
2. Identify potential Security Vectors (e.g., "Will this execute arbitrary code?", "Could this leak PII to a 3rd party?").
3. Identify API Secret requirements (Does this need a new `.env` key?).
*Present this brief analysis to the user and ask for their approval to begin.*

## Phase 2: Documentation Research (Mandatory)
If the feature involves a 3rd-party API (Slack, ClickUp, Telegram, etc.):
1. You MUST use your `web_search` and `web_fetch` tools to read the **latest** official documentation.
2. Do not rely on your training memory, as APIs deprecate rapidly.

## Phase 3: Secure Dependency Management
If you need to install a new Node/NPM package:
1. Remember the hard guardrail: You are blocked from using `bash` to run `npm install`.
2. You MUST use the `secure_npm_install` tool.
3. This ensures the package is audited for vulnerabilities and typosquatting before it touches the platform.

## Phase 4: Secure Scaffolding
When writing the code (using your `write` or `edit` tools):
1. **Never hardcode secrets.** Always use `process.env.YOUR_KEY`.
2. **Never log secrets.** Ensure `console.log` statements do not accidentally output API keys or PII.
3. **Respect Isolation.** If building a feature for a specific bot, place its data in `data/${process.env.BOT_NAME}/`, not the root directory.

## Phase 5: Test-Driven Development (TDD)
You are under a strict TDD Global Directive.
1. Before finalizing the code, you must write a `.test.ts` file for the feature.
2. The test MUST specifically cover the security/privacy edge cases you identified in Phase 1 (e.g., testing that invalid inputs are rejected).

## Phase 6: Verify & Commit
1. You are forbidden from telling the user "I am done" until the tests pass.
2. Call the `verify_and_commit` tool with a clear commit message.
3. If the tool rejects your commit (because a test failed), you must fix the code and try again.
4. Once the commit succeeds, inform the user that the evolution is complete and structurally secure. Tell them if they need to add any new keys.
5. Activate the new extension's tools in the live session:
   - **From chat (Telegram/Slack/A2A):** call the `reload_extensions` tool (admin-only). No terminal trip required. New tools become callable on the NEXT message.
   - **From the TUI:** the operator types `/reload` directly.
   - **Source-level changes** (anything outside `.pi/` — e.g. `src/transport/`): require a full process restart; neither reload path covers them.
