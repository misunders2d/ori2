---
name: adding-capabilities
description: "Use this skill when the user asks how to add new tools, integrations, or capabilities to you — e.g., 'how do I add an Amazon integration', 'how can I evolve you', 'what are skills/extensions', 'how does this compare to LangChain/ADK sub-agents', 'where do tools live'. Explain the mental model BEFORE jumping into code."
---

# How Ori2 Grows (Answering User Questions About Evolution)

When a user asks you *how* they can add capabilities, teach them the mental model first, then point them at the tactical SOP. Keep it short — this is usually a conversation, not a lecture.

## The mental model in three lines

1. **Extensions** (`.pi/extensions/<name>.ts`) are TypeScript files that register *tools* (LLM-callable functions), *slash commands*, and *hooks*. One extension per domain (e.g., `amazon.ts`, `keepa.ts`).
2. **Skills** (`.pi/skills/<name>/SKILL.md`) are structured markdown documents you read lazily when relevant. They're your cookbook — "when to use which tool, required data, common pitfalls".
3. An **extension + skill pair** ≈ a sub-agent in frameworks like Google ADK or LangChain. One file for the tools, one file for the instructions. Same practical effect, zero multi-agent coordination tax.

## The simple recipe

When a user says "I want to add X":

1. **Clarify scope.** One domain (Amazon SP-API) or a grab-bag of unrelated tools? Keep one domain per extension.
2. **Identify data + secrets.** What credentials will the extension need? Route them through `/credentials add` or `/oauth` so they never enter your context.
3. **Write the extension** at `.pi/extensions/<domain>.ts` — register the tools via `pi.registerTool(...)`. Keep tool descriptions precise (they become your own "job description" for when to call them).
4. **Write the skill** at `.pi/skills/<domain>-ops/SKILL.md` — tell future-you when to use which tool, required args, edge cases. The `description:` frontmatter is what triggers auto-loading.
5. **Test + reload.** Use Pi's built-in `write` tool to create the files at `.pi/extensions/<domain>.ts` and `.pi/skills/<domain>-ops/SKILL.md`. Then run `/reload` to activate.

For the full safe-evolution framework (threat modelling, dependency auditing, TDD, commit flow), use the **evolution-sop** skill — that's the rigid 6-phase SOP for non-trivial features.

## When to split into modes or instances

| Situation | Pattern | Where |
|---|---|---|
| One operator, 1–4 domains, tools mostly orthogonal | All extensions in one instance. | This instance. |
| Tool list got noisy (30+ tools confuse tool-picking) | Add modes: `pi.setActiveTools([...])` + mode-specific system prompt via `before_agent_start`. | Edit `persona.ts` + add `.pi/extensions/mode-switcher.ts`. |
| Separate teams want independent evolution paths | Split into multiple ori2 instances, one per role. Communicate via A2A. | New VPS / checkout; friend via `/a2a invite`. |
| Task is long-running with a bounded scope (e.g. "research this product line for 2 hours") | Subprocess subagent (Pi's `examples/extensions/subagent/`). | Spawn scoped Pi session, return structured result. |

## What the user should hear

Short version, suitable for "how do I add Amazon SP-API?":

> "You write one TypeScript file at `.pi/extensions/amazon.ts` with the tools — `amazon_list_orders`, `amazon_get_listing`, etc. — plus one markdown file at `.pi/skills/amazon-ops/SKILL.md` telling me when to use which. That pair acts as my 'Amazon sub-agent'. I can write them both for you using my `write` tool, then `/reload` to activate. If it's a non-trivial integration I'll follow the 6-phase safe-evolution SOP — want me to start with a threat model, or do you just want to sketch the tool list?"

## Cross-references

- `.pi/skills/evolution-sop` — the rigid 6-phase TDD safe-evolution framework. Use for non-trivial features.
- `.pi/skills/github-setup` — help with publishing the bot's evolved code to the operator's own GitHub.
- `/evolve help` — the operator-facing surface (list, diff, commit path).
- `/dna feature add <id> <files...>` — package a proven extension+skill pair for DNA export to friend bots.

## Don't

- Don't write code until the user agrees to the scope.
- Don't hardcode secrets — route through `/credentials` or `/oauth` first.
- Don't start with architecture lectures. Explain the mental model (extension=tools, skill=instructions) and move on.
- Don't propose splitting into separate ori2 instances until the user has an actual team-boundary reason. Single-instance multi-extension is the default.
