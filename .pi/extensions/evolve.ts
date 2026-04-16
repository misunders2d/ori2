import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import { currentOrigin } from "../../src/core/identity.js";
import { getWhitelist } from "../../src/core/whitelist.js";

// =============================================================================
// evolve — chat-driven extension/skill authoring with hot reload.
//
// The platform's "raise it your way" promise lives here. The agent (under
// admin direction) writes new TypeScript extensions or markdown skills into
// the project directory, then triggers /reload so they take effect without
// a process restart.
//
// Tools:
//   evolve_extension(name, content) — write .pi/extensions/<name>.ts
//   evolve_skill(name, content)     — write .pi/skills/<name>/SKILL.md
//   evolve_list                      — what extensions/skills exist now
//
// Slash commands:
//   /evolve help
//   /evolve list
//   /evolve diff   — git diff vs HEAD (uses git, falls back gracefully)
//
// Safety:
//   - All mutating tools require admin (default ACL).
//   - Names are sanitised (alphanumerics + dashes/underscores only).
//   - Files written ATOMICALLY (tmp + rename) so /reload never sees half-written code.
//   - On reload failure, the bot stays alive — the bad extension is just
//     reported as a load error in the logs. Operator can `git restore`
//     to roll back.
//   - The agent's persona prompt should reinforce: write tests, use the
//     `evolution-sop` skill (.pi/skills/evolution-sop.md is bundled).
//
// What we DON'T do here:
//   - Syntax-check / typecheck the code before writing. tsc is available
//     via npx but adds ~5s per evolution. The agent should write code that
//     compiles; if not, /reload reports the error. (Future enhancement:
//     optional pre-write typecheck.)
//   - Auto-commit. The agent can call git via the bash tool when ready.
//     Auto-commit on every evolution is too aggressive (false starts,
//     experimentation).
//   - Backup. Git history is the backup.
// =============================================================================

const EXTENSIONS_DIR = path.resolve(process.cwd(), ".pi/extensions");
const SKILLS_DIR = path.resolve(process.cwd(), ".pi/skills");
const PROMPTS_DIR = path.resolve(process.cwd(), ".pi/prompts");

// Sanitise a name: keep alphanumerics, underscores, dashes. Reject anything
// that looks like a path traversal attempt.
const SAFE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function isAdminCaller(ctx: ExtensionContext): boolean {
    const origin = currentOrigin(ctx.sessionManager);
    if (!origin) return true;
    return getWhitelist().isAdmin(origin.platform, origin.senderId);
}

function atomicWriteText(file: string, content: string): void {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o644);
    try {
        fs.writeSync(fd, content);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
}

function listFiles(dir: string, suffix: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(suffix)).sort();
}

function listSkillDirs(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.name.endsWith(".md"))
        .map((d) => d.name)
        .sort();
}

export default function (pi: ExtensionAPI) {
    // ----- LLM tools (admin-only via Sprint 5 ACL — not in defaults yet, see below) -----

    pi.registerTool({
        name: "evolve_extension",
        label: "Evolve: Write Extension",
        description:
            "Write a new (or replace existing) Pi extension at .pi/extensions/<name>.ts. " +
            "The file is written atomically. Caller MUST follow up with /reload to load it. " +
            "Admin-only. The extension MUST export a default function that receives " +
            "ExtensionAPI and registers tools/commands/event handlers. See bundled examples " +
            "(memory.ts, oauth.ts, scheduler.ts, etc.) and follow the evolution-sop skill: " +
            "research the API, write tests, use secure_npm_install for any new deps, then " +
            "verify_and_commit when done.",
        parameters: Type.Object({
            name: Type.String({ description: "Extension name (alphanumeric, _ or -). Becomes <name>.ts in .pi/extensions/." }),
            content: Type.String({ description: "Full file content. Should start with `import type { ExtensionAPI } from \"@mariozechner/pi-coding-agent\";` and `export default function (pi: ExtensionAPI) { ... }`." }),
        }),
        async execute(_id, params) {
            if (!SAFE_NAME.test(params.name)) {
                throw new Error(`evolve_extension: invalid name "${params.name}". Allowed: a-z A-Z 0-9 _ - (1-64 chars).`);
            }
            if (!params.content || !params.content.includes("export default")) {
                throw new Error("evolve_extension: content missing required `export default function (pi: ExtensionAPI)`.");
            }
            const file = path.join(EXTENSIONS_DIR, `${params.name}.ts`);
            const existed = fs.existsSync(file);
            atomicWriteText(file, params.content);
            return {
                content: [{
                    type: "text",
                    text:
                        `${existed ? "Replaced" : "Created"} extension at ${file} (${params.content.length} chars).\n` +
                        `Now run /reload to activate it. If reload reports a TypeScript error, ` +
                        `read the message and either fix the code (call evolve_extension again with the corrected content) ` +
                        `or revert with: git restore ${path.relative(process.cwd(), file)}.`,
                }],
                details: { file, name: params.name, replaced: existed, bytes: params.content.length },
            };
        },
    });

    pi.registerTool({
        name: "evolve_skill",
        label: "Evolve: Write Skill",
        description:
            "Write a new (or replace existing) skill at .pi/skills/<name>/SKILL.md. Skills are " +
            "markdown instruction sets the agent loads on demand via /skill:<name>. Admin-only.",
        parameters: Type.Object({
            name: Type.String({ description: "Skill name (alphanumeric, _ or -)." }),
            content: Type.String({ description: "Full SKILL.md content. Should start with YAML frontmatter (name, description, type)." }),
        }),
        async execute(_id, params) {
            if (!SAFE_NAME.test(params.name)) {
                throw new Error(`evolve_skill: invalid name "${params.name}". Allowed: a-z A-Z 0-9 _ - (1-64 chars).`);
            }
            const dir = path.join(SKILLS_DIR, params.name);
            const file = path.join(dir, "SKILL.md");
            const existed = fs.existsSync(file);
            atomicWriteText(file, params.content);
            return {
                content: [{
                    type: "text",
                    text:
                        `${existed ? "Replaced" : "Created"} skill at ${file} (${params.content.length} chars).\n` +
                        `Run /reload to make it discoverable. The skill becomes invokable as ` +
                        `/skill:${params.name} after reload.`,
                }],
                details: { file, name: params.name, replaced: existed },
            };
        },
    });

    pi.registerTool({
        name: "evolve_list",
        label: "Evolve: List Extensions and Skills",
        description: "List all currently-installed extensions, skills, and prompts in this project's .pi/ directory.",
        parameters: Type.Object({}),
        async execute() {
            const extensions = listFiles(EXTENSIONS_DIR, ".ts");
            const skills = listSkillDirs(SKILLS_DIR);
            const prompts = listFiles(PROMPTS_DIR, ".md");
            const lines = [
                `Extensions (.pi/extensions/): ${extensions.length}`,
                ...extensions.map((f) => `  ${f}`),
                ``,
                `Skills (.pi/skills/): ${skills.length}`,
                ...skills.map((f) => `  ${f}`),
                ``,
                `Prompts (.pi/prompts/): ${prompts.length}`,
                ...prompts.map((f) => `  ${f}`),
            ];
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: { extensions, skills, prompts },
            };
        },
    });

    // ----- slash commands -----

    pi.registerCommand("evolve", {
        description: "Evolution surface. Run /evolve help.",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "help").toLowerCase();
            const mutating = sub === "reload-now"; // future: explicit reload trigger
            if (mutating && !isAdminCaller(ctx)) {
                ctx.ui.notify(`Only admins can run /evolve ${sub}.`, "error");
                return;
            }
            switch (sub) {
                case "help":      return doHelp(ctx);
                case "list":      return doList(ctx);
                case "diff":      return await doDiff(ctx);
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
        "  Lets the agent (under admin direction) write new Pi extensions",
        "  (.pi/extensions/<name>.ts) and skills (.pi/skills/<name>/SKILL.md).",
        "  After write, run /reload to load the new code WITHOUT restarting",
        "  the bot. If reload reports an error, fix-and-retry or git restore.",
        "",
        "  Bundled skill `evolution-sop` documents the recommended workflow:",
        "    research → threat model → secure_npm_install → write code →",
        "    write tests → verify_and_commit. Always invoke /skill:evolution-sop",
        "    before significant evolution work.",
        "",
        "TOOLS THE AGENT CAN CALL (admin-only)",
        "  evolve_extension(name, content)  — write a new Pi extension",
        "  evolve_skill(name, content)      — write a new skill",
        "  evolve_list                       — enumerate current extensions/skills",
        "",
        "WORKFLOW EXAMPLE",
        "  Operator: \"Build a tool that posts to my SendGrid mailing list.\"",
        "  Agent (in admin chat):",
        "    1. /skill:evolution-sop",
        "    2. web_search(\"SendGrid API send email\")",
        "    3. web_fetch(<docs URL>)",
        "    4. /credentials help → asks operator to add SENDGRID_KEY via",
        "       /credentials add sendgrid <key> --provider sendgrid",
        "    5. evolve_extension(name=\"sendgrid_send\", content=<the new code>)",
        "    6. /reload",
        "    7. test the new tool",
        "    8. verify_and_commit if appropriate",
        "",
        "ALL SUBCOMMANDS",
        "  /evolve help          — this message",
        "  /evolve list          — current extensions, skills, prompts",
        "  /evolve diff          — git diff against HEAD (what's been evolved this session)",
        "",
        "ROLLBACK",
        "  Every evolution is just a file write — git is the source of truth.",
        "    git status           — see what was added/changed",
        "    git diff             — review",
        "    git restore <path>   — undo a single file",
        "    git restore .pi/     — undo all evolution changes",
        "",
        "═════════════════════════════════════════════════════════════",
    ];
    ctx.ui.notify(lines.join("\n"), "info");
}

function doList(ctx: ExtensionContext): void {
    const extensions = listFiles(EXTENSIONS_DIR, ".ts");
    const skills = listSkillDirs(SKILLS_DIR);
    const prompts = listFiles(PROMPTS_DIR, ".md");
    const lines = [
        `Extensions (${extensions.length}):`,
        ...extensions.map((f) => `  ${f}`),
        ``,
        `Skills (${skills.length}):`,
        ...skills.map((f) => `  ${f}`),
        ``,
        `Prompts (${prompts.length}):`,
        ...prompts.map((f) => `  ${f}`),
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
