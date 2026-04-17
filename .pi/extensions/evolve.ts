import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";

// =============================================================================
// evolve — discoverability + diff surface for the operator.
//
// The heavy lifting of "write a new extension" / "write a new skill" is done
// by Pi's built-in `write` / `edit` tools (default-registered — see
// pi-coding-agent/docs §Tool Options: read, bash, edit, write). The agent
// writes `.pi/extensions/<name>.ts` or `.pi/skills/<name>/SKILL.md` the same
// way it writes any other file, then calls `/reload` (pi-coding-agent native)
// to make the new code/skill live in the current session — no restart.
//
// This extension adds operator-facing sugar on top of Pi's built-ins:
//
//   evolve_list     — read-only tool so the agent can enumerate what's
//                     installed when asked "what extensions do you have?"
//                     without shelling out to bash ls.
//   /evolve help    — documents the Pi-native evolve-by-write workflow.
//   /evolve list    — operator version of evolve_list.
//   /evolve diff    — `git diff --stat HEAD -- .pi/` — what have we evolved
//                     this session? Valuable before `git commit`.
//
// Why no custom write-extension tool:
//   Earlier versions had evolve_extension / evolve_skill tools. They were
//   thin wrappers over an atomic file write, which is exactly what Pi's
//   built-in `write` tool already does. Removing duplication — see the
//   pi-alignment-plan.md Phase 3 audit for the reasoning.
//
// Safety:
//   Path-allowlist protection (the agent may write anywhere Pi's `write`
//   tool allows) is handled by admin_gate + tool_acl for the `write` tool
//   itself. If you need to restrict writes to `.pi/extensions/` specifically,
//   add a policy.ts rule (deny `write` when path is outside allowed prefixes).
//   See pi-coding-agent examples/extensions/protected-paths.ts for reference.
// =============================================================================

const EXTENSIONS_DIR = path.resolve(process.cwd(), ".pi/extensions");
const SKILLS_DIR = path.resolve(process.cwd(), ".pi/skills");
const APPEND_SYSTEM_FILE = path.resolve(process.cwd(), ".pi/APPEND_SYSTEM.md");

function listFiles(dir: string, suffix: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(suffix)).sort();
}

function listSkillDirs(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
}

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "evolve_list",
        label: "Evolve: List Extensions and Skills",
        description:
            "List installed extensions (.pi/extensions/*.ts) and skills (.pi/skills/<name>/SKILL.md) " +
            "plus whether .pi/APPEND_SYSTEM.md is present. Use when the user asks what capabilities " +
            "are installed or available to evolve. To CREATE or MODIFY an extension/skill, use Pi's " +
            "built-in `write` tool + then `/reload` — not a separate evolve tool.",
        parameters: Type.Object({}),
        async execute() {
            const extensions = listFiles(EXTENSIONS_DIR, ".ts").filter((f) => !f.endsWith(".test.ts"));
            const skills = listSkillDirs(SKILLS_DIR);
            const appendSystem = fs.existsSync(APPEND_SYSTEM_FILE);
            const lines = [
                `Extensions (.pi/extensions/): ${extensions.length}`,
                ...extensions.map((f) => `  ${f}`),
                ``,
                `Skills (.pi/skills/): ${skills.length}`,
                ...skills.map((f) => `  ${f}/SKILL.md`),
                ``,
                `.pi/APPEND_SYSTEM.md: ${appendSystem ? "present" : "(not set)"}`,
            ];
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: { extensions, skills, appendSystem },
            };
        },
    });

    pi.registerCommand("evolve", {
        description: "Evolution surface. Run /evolve help.",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "help").toLowerCase();
            switch (sub) {
                case "help": return doHelp(ctx);
                case "list": return doList(ctx);
                case "diff": return await doDiff(ctx);
                default:
                    ctx.ui.notify(`Unknown /evolve subcommand: ${sub}. Run /evolve help.`, "error");
            }
        },
    });
}

function doHelp(ctx: ExtensionContext): void {
    const lines = [
        "═════════════════════════════════════════════════════════════",
        "  /evolve — chat-driven extension and skill authoring",
        "═════════════════════════════════════════════════════════════",
        "",
        "WHAT THIS DOES",
        "  Ori2's evolution model uses Pi's native building blocks:",
        "    Pi's built-in `write` tool → writes the file",
        "    Pi's `/reload` slash command → loads it without restart",
        "  This slash command gives you the surface to discover state",
        "  (list, diff) and tells the agent the workflow. The actual",
        "  write + reload mechanics are Pi-native, no custom tool.",
        "",
        "  Bundled skill `evolution-sop` documents the safe 6-phase flow:",
        "    threat model → research docs → secure_npm_install → write →",
        "    tests → verify_and_commit. Always invoke /skill:evolution-sop",
        "    before significant evolution work.",
        "",
        "WORKFLOW EXAMPLE",
        "  Operator: \"Build a tool that posts to my SendGrid mailing list.\"",
        "  Agent (in admin chat):",
        "    1. /skill:evolution-sop",
        "    2. web_search(\"SendGrid API send email\")",
        "    3. web_fetch(<docs URL>)",
        "    4. /credentials help → have operator add SENDGRID_KEY via",
        "       /credentials add sendgrid <key> --provider sendgrid",
        "    5. write(path=\".pi/extensions/sendgrid_send.ts\", content=<code>)",
        "    6. /reload",
        "    7. test the new tool",
        "    8. verify_and_commit when green",
        "",
        "SKILLS (markdown, read lazily by the agent)",
        "  Write `.pi/skills/<name>/SKILL.md` with YAML frontmatter",
        "  (`name`, `description`). Pi auto-discovers on next `/reload`.",
        "",
        "SYSTEM-PROMPT CUSTOMISATION (persona / static directives)",
        "  Edit `.pi/APPEND_SYSTEM.md` — Pi appends it to the default",
        "  system prompt automatically. No reload needed; applies to the",
        "  next new session (or /new).",
        "",
        "ALL SUBCOMMANDS",
        "  /evolve help   — this message",
        "  /evolve list   — current extensions + skills + APPEND_SYSTEM state",
        "  /evolve diff   — git diff --stat HEAD -- .pi/",
        "",
        "ROLLBACK",
        "  Every evolution is just a file write — git is the source of truth:",
        "    git status           — what's changed",
        "    git diff             — review",
        "    git restore <path>   — undo a single file",
        "    git restore .pi/     — undo all .pi/ changes in this session",
        "",
        "═════════════════════════════════════════════════════════════",
    ];
    ctx.ui.notify(lines.join("\n"), "info");
}

function doList(ctx: ExtensionContext): void {
    const extensions = listFiles(EXTENSIONS_DIR, ".ts").filter((f) => !f.endsWith(".test.ts"));
    const skills = listSkillDirs(SKILLS_DIR);
    const appendSystem = fs.existsSync(APPEND_SYSTEM_FILE);
    const lines = [
        `Extensions (${extensions.length}):`,
        ...extensions.map((f) => `  ${f}`),
        ``,
        `Skills (${skills.length}):`,
        ...skills.map((f) => `  ${f}/SKILL.md`),
        ``,
        `APPEND_SYSTEM.md: ${appendSystem ? "present" : "(not set)"}`,
    ];
    ctx.ui.notify(lines.join("\n"), "info");
}

async function doDiff(ctx: ExtensionContext): Promise<void> {
    try {
        const { spawn } = await import("node:child_process");
        const proc = spawn("git", ["diff", "--stat", "HEAD", "--", ".pi/"], {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
        await new Promise<void>((resolve) => proc.on("close", () => resolve()));
        if (err && !out) {
            ctx.ui.notify(`git diff failed: ${err.trim()}\nIs the project a git repo?`, "warning");
            return;
        }
        if (!out.trim()) {
            ctx.ui.notify("No changes in .pi/ vs HEAD.", "info");
            return;
        }
        ctx.ui.notify(`Changes in .pi/ vs HEAD:\n${out}`, "info");
    } catch (e) {
        ctx.ui.notify(`Diff failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
}
