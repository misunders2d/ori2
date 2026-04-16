import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { currentOrigin } from "../../src/core/identity.js";
import { getMemory } from "../../src/core/memory.js";
import { getWhitelist } from "../../src/core/whitelist.js";

// =============================================================================
// memory — Pi extension exposing the LLM-callable memory tools and admin
// slash commands.
//
// Tools (LLM-callable):
//   memory_save     — save a fact/preference/decision (default ACL: user)
//   memory_search   — semantic search                  (default ACL: user)
//   memory_get      — fetch full record by id          (default ACL: user)
//   memory_delete   — delete a record                  (default ACL: admin)
//   memory_list_tags — enumerate tags + counts          (default ACL: user)
//
// Slash commands (operator-facing):
//   /memory help
//   /memory list [--tag T] [--limit N]
//   /memory search <query>
//   /memory get <id>
//   /memory tags
//   /memory stats
//   /memory delete <id>     (admin)
//   /memory clear --confirm (admin)
//
// USAGE FROM EVOLVED TOOLS
//   import { getMemory } from "../../src/core/memory.js";
//   await getMemory().save({ content: "...", tags: [...], addedBy: "..." });
//   const hits = await getMemory().search("query", { topK: 5, filterTags: [...] });
// =============================================================================

const memory = getMemory();
const whitelist = getWhitelist();

function isAdminCaller(ctx: ExtensionContext): boolean {
    const origin = currentOrigin(ctx.sessionManager);
    if (!origin) return true; // CLI fallback
    return whitelist.isAdmin(origin.platform, origin.senderId);
}

function callerLabel(ctx: ExtensionContext): string {
    const origin = currentOrigin(ctx.sessionManager);
    if (!origin) return "cli";
    return `${origin.platform}:${origin.senderId}`;
}

function fmtAge(epoch: number): string {
    const sec = Math.round((Date.now() - epoch) / 1000);
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    if (sec < 86400) return `${Math.round(sec / 3600)}h`;
    return `${Math.round(sec / 86400)}d`;
}

function truncate(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n)}…` : s;
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export default function (pi: ExtensionAPI) {
    // ------------------- LLM tools -------------------

    pi.registerTool({
        name: "memory_save",
        label: "Save Memory",
        description:
            "Save a fact, preference, decision, or observation to the bot's long-term memory. " +
            "Use proactively for things you want to recall later — user preferences, project " +
            "context, prior decisions, learned domain knowledge. Tag well so the recall search " +
            "can filter. Returns the new memory id.\n" +
            "DO NOT save secrets/tokens here — the content is searchable verbatim. Use the " +
            "vault or /credentials for those.",
        parameters: Type.Object({
            content: Type.String({ description: "The fact/preference/decision to remember" }),
            tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for filtering future recalls (e.g. ['user-preference', 'amazon-listings', 'q4-2025'])" })),
            metadata: Type.Optional(Type.Object({}, { description: "Optional structured metadata (any JSON-serializable object)" })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const record = await memory.save({
                content: params.content,
                tags: params.tags ?? [],
                ...(params.metadata !== undefined ? { metadata: params.metadata as Record<string, unknown> } : {}),
                addedBy: callerLabel(ctx),
                source: "agent_save",
            });
            return {
                content: [{ type: "text", text: `Saved memory #${record.id} (${record.tags.length} tag${record.tags.length === 1 ? "" : "s"}: ${record.tags.join(", ") || "(none)"}).` }],
                details: { id: record.id, tags: record.tags },
            };
        },
    });

    pi.registerTool({
        name: "memory_search",
        label: "Search Memory",
        description:
            "Semantic search across the bot's long-term memory. Use BEFORE asking the user " +
            "questions whose answers might already be remembered. Returns top matches sorted " +
            "by similarity (best first). Optional tag filter narrows results to records " +
            "containing any of the listed tags.",
        parameters: Type.Object({
            query: Type.String({ description: "Natural-language query — e.g. 'what does the user prefer for email subject lines?'" }),
            top_k: Type.Optional(Type.Number({ description: "Max results to return (default 5, capped at 50)" })),
            filter_tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tag filter; results must have at least one of these tags" })),
            min_similarity: Type.Optional(Type.Number({ description: "Skip results below this cosine similarity threshold (0..1, default 0)" })),
        }),
        async execute(_id, params) {
            const opts: { topK?: number; filterTags?: string[]; minSimilarity?: number } = {};
            if (params.top_k !== undefined) opts.topK = params.top_k;
            if (params.filter_tags !== undefined) opts.filterTags = params.filter_tags;
            if (params.min_similarity !== undefined) opts.minSimilarity = params.min_similarity;
            const results = await memory.search(params.query, opts);
            if (results.length === 0) {
                return {
                    content: [{ type: "text", text: `No memories match "${truncate(params.query, 60)}".` }],
                    details: { results: [] },
                };
            }
            const lines = results.map((r, i) =>
                `[${i + 1}] #${r.record.id} sim=${r.similarity.toFixed(3)} tags=[${r.record.tags.join(", ")}]\n    ${truncate(r.record.content, 300)}`,
            );
            return {
                content: [{ type: "text", text: lines.join("\n\n") }],
                details: { results: results.map((r) => ({ id: r.record.id, similarity: r.similarity, tags: r.record.tags })) },
            };
        },
    });

    pi.registerTool({
        name: "memory_get",
        label: "Get Memory By ID",
        description: "Fetch the full content of a single memory by id (returned by memory_search).",
        parameters: Type.Object({
            id: Type.Number({ description: "Memory id" }),
        }),
        async execute(_id, params) {
            type GetDetails = { id: number; found: boolean; tags: string[] | null };
            const record = memory.getById(params.id);
            if (!record) {
                const details: GetDetails = { id: params.id, found: false, tags: null };
                return {
                    content: [{ type: "text", text: `Memory #${params.id} not found.` }],
                    details,
                };
            }
            const meta = record.metadata ? `\nmetadata: ${JSON.stringify(record.metadata)}` : "";
            const details: GetDetails = { found: true, id: record.id, tags: record.tags };
            return {
                content: [{ type: "text", text:
                    `Memory #${record.id}\n` +
                    `tags: [${record.tags.join(", ")}]\n` +
                    `added: ${new Date(record.added_at).toISOString()} by ${record.added_by ?? "(unknown)"}\n` +
                    `source: ${record.source ?? "(unknown)"}${meta}\n\n` +
                    record.content,
                }],
                details,
            };
        },
    });

    pi.registerTool({
        name: "memory_delete",
        label: "Delete Memory",
        description: "Delete a memory by id. Admin-only. Use with care — deletion is immediate and irreversible.",
        parameters: Type.Object({
            id: Type.Number({ description: "Memory id to delete" }),
        }),
        async execute(_id, params) {
            const ok = memory.delete(params.id);
            return {
                content: [{ type: "text", text: ok ? `Deleted memory #${params.id}.` : `Memory #${params.id} not found.` }],
                details: { id: params.id, deleted: ok },
            };
        },
    });

    pi.registerTool({
        name: "memory_reset",
        label: "Reset Memory (wipe all)",
        description:
            "Wipe ALL long-term memories. Admin-only and irreversible — there is no undo. " +
            "Use sparingly: when the user explicitly says 'forget everything', when starting " +
            "a fresh deployment, or when memory has been polluted with bad data. The agent " +
            "should ALWAYS confirm with the user before invoking this. Returns the number of " +
            "records deleted. Requires the boolean parameter `confirm: true` to actually run; " +
            "any other value is a no-op so the agent can't fire it accidentally.",
        parameters: Type.Object({
            confirm: Type.Boolean({ description: "Must be literally true to proceed. Any other value is a no-op." }),
        }),
        async execute(_id, params) {
            if (params.confirm !== true) {
                return {
                    content: [{ type: "text", text: "memory_reset NOT executed: pass `confirm: true` to wipe." }],
                    details: { reset: false, deleted: 0 },
                };
            }
            const n = memory.clear();
            return {
                content: [{ type: "text", text: `Wiped ${n} memor${n === 1 ? "y" : "ies"}. Long-term memory is now empty.` }],
                details: { reset: true, deleted: n },
            };
        },
    });

    pi.registerTool({
        name: "memory_list_tags",
        label: "List Memory Tags",
        description: "List all distinct tags in the memory store with counts. Use to discover what tags exist before a tag-filtered search.",
        parameters: Type.Object({}),
        async execute() {
            const tags = memory.listTags();
            if (tags.length === 0) {
                return {
                    content: [{ type: "text", text: "No tags in memory yet." }],
                    details: { tags: [] },
                };
            }
            const lines = tags.map((t) => `  ${t.tag.padEnd(28)} ${t.count}`);
            return {
                content: [{ type: "text", text: `Tags (${tags.length} distinct):\n${lines.join("\n")}` }],
                details: { tags },
            };
        },
    });

    // ------------------- slash commands -------------------

    pi.registerCommand("memory", {
        description: "Long-term memory store. Run /memory help for full reference.",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "help").toLowerCase();

            const mutating = sub === "delete" || sub === "clear";
            if (mutating && !isAdminCaller(ctx)) {
                ctx.ui.notify("Only admins can run /memory " + sub + ".", "error");
                return;
            }

            switch (sub) {
                case "help":   return doHelp(ctx);
                case "list":   return await doList(ctx, parts);
                case "search": return await doSearch(ctx, args ?? "");
                case "get":    return doGet(ctx, parts);
                case "tags":   return doTags(ctx);
                case "stats":  return doStats(ctx);
                case "delete": return doDelete(ctx, parts);
                case "clear":  return doClear(ctx, parts);
                default:
                    ctx.ui.notify(`Unknown /memory subcommand: ${sub}. Run /memory help.`, "error");
            }
        },
    });
}

// ------------------- handlers -------------------

function doHelp(ctx: ExtensionContext): void {
    const lines = [
        "═════════════════════════════════════════════════════════════",
        "  /memory — long-term semantic memory",
        "═════════════════════════════════════════════════════════════",
        "",
        "WHAT THIS DOES",
        "  Stores facts, preferences, decisions, and learned context the",
        "  bot can recall later via semantic search. Backed by SQLite +",
        "  sqlite-vec; embeddings are local (BGE-small via fastembed) —",
        "  no cloud calls, your memory never leaves the VPS.",
        "",
        "  Storage:  data/<BOT>/memory.db",
        "  Embedder: BGE-small-en-v1.5 (384-dim, ~130MB ONNX, shared",
        "            with the prompt-injection guardrail)",
        "",
        "INTENDED USE",
        "  - User/team preferences (\"prefers bullet points over prose\")",
        "  - Project context (\"this repo follows trunk-based development\")",
        "  - Past decisions (\"chose Postgres over MongoDB because ...\")",
        "  - Domain knowledge (\"SKU prefix MAR- = Marketing line\")",
        "  - DO NOT save secrets or tokens — content is searchable",
        "    verbatim. Use the vault or /credentials for those.",
        "",
        "WHAT THE LLM CAN DO",
        "  Six tools, all role-gated via /tool-acl:",
        "    memory_save       — save a fact            (default: user)",
        "    memory_search     — semantic search         (default: user)",
        "    memory_get        — fetch by id             (default: user)",
        "    memory_list_tags  — enumerate tags          (default: user)",
        "    memory_delete     — delete by id            (default: admin)",
        "    memory_reset      — wipe ALL memory         (default: admin, requires confirm:true)",
        "  The persona prompt should encourage the agent to search BEFORE",
        "  asking questions whose answers might already be remembered.",
        "",
        "ALL SUBCOMMANDS",
        "  /memory help                               — this message",
        "  /memory list [--tag T] [--limit N]         — recent records (default 20)",
        "  /memory search <query>                     — semantic search",
        "  /memory get <id>                           — full record",
        "  /memory tags                               — distinct tags + counts",
        "  /memory stats                              — count, db size, age range",
        "  /memory delete <id>                        — admin",
        "  /memory clear --confirm                    — admin: wipe all memory",
        "",
        "═════════════════════════════════════════════════════════════",
    ];
    ctx.ui.notify(lines.join("\n"), "info");
}

async function doList(ctx: ExtensionContext, parts: string[]): Promise<void> {
    let limit = 20;
    let filterTag: string | undefined;
    for (let i = 1; i < parts.length; i++) {
        if (parts[i] === "--limit" && i + 1 < parts.length) { limit = Math.max(1, Number(parts[i + 1]) || 20); i++; }
        else if (parts[i] === "--tag" && i + 1 < parts.length) { filterTag = parts[i + 1]; i++; }
    }
    const records = memory.listRecent(limit);
    const filtered = filterTag ? records.filter((r) => r.tags.includes(filterTag!)) : records;
    if (filtered.length === 0) {
        ctx.ui.notify(filterTag ? `No memories with tag "${filterTag}".` : "Memory is empty.", "info");
        return;
    }
    const lines = ["Recent memories:", ""];
    for (const r of filtered) {
        const tags = r.tags.length > 0 ? `[${r.tags.join(", ")}]` : "";
        lines.push(`  #${String(r.id).padStart(4)} ${fmtAge(r.added_at).padEnd(6)} ago  ${tags} ${truncate(r.content, 80)}`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
}

async function doSearch(ctx: ExtensionContext, args: string): Promise<void> {
    const q = args.replace(/^\s*search\s+/i, "").trim();
    if (!q) { ctx.ui.notify("Usage: /memory search <query>", "error"); return; }
    const results = await memory.search(q, { topK: 10 });
    if (results.length === 0) { ctx.ui.notify(`No matches for "${truncate(q, 60)}".`, "info"); return; }
    const lines = [`Search results for "${truncate(q, 60)}":`, ""];
    for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        lines.push(`[${i + 1}] #${r.record.id} sim=${r.similarity.toFixed(3)} tags=[${r.record.tags.join(", ")}]`);
        lines.push(`    ${truncate(r.record.content, 200)}`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
}

function doGet(ctx: ExtensionContext, parts: string[]): void {
    const id = Number(parts[1]);
    if (!Number.isFinite(id)) { ctx.ui.notify("Usage: /memory get <id>", "error"); return; }
    const record = memory.getById(id);
    if (!record) { ctx.ui.notify(`Memory #${id} not found.`, "error"); return; }
    const lines = [
        `Memory #${record.id}`,
        `  tags:    [${record.tags.join(", ")}]`,
        `  added:   ${new Date(record.added_at).toISOString()} by ${record.added_by ?? "(unknown)"}`,
        `  source:  ${record.source ?? "(unknown)"}`,
    ];
    if (record.metadata) lines.push(`  metadata: ${JSON.stringify(record.metadata)}`);
    lines.push("", record.content);
    ctx.ui.notify(lines.join("\n"), "info");
}

function doTags(ctx: ExtensionContext): void {
    const tags = memory.listTags();
    if (tags.length === 0) { ctx.ui.notify("No tags in memory yet.", "info"); return; }
    const lines = [`Tags (${tags.length} distinct):`, ""];
    for (const t of tags) lines.push(`  ${t.tag.padEnd(28)} ${t.count}`);
    ctx.ui.notify(lines.join("\n"), "info");
}

function doStats(ctx: ExtensionContext): void {
    const s = memory.stats();
    const lines = [
        `Memory stats:`,
        `  total records:  ${s.count}`,
        `  unique tags:    ${s.uniqueTags}`,
        `  db size:        ${fmtBytes(s.dbSizeBytes)}`,
    ];
    if (s.oldestAt) lines.push(`  oldest:         ${new Date(s.oldestAt).toISOString()} (${fmtAge(s.oldestAt)} ago)`);
    if (s.newestAt) lines.push(`  newest:         ${new Date(s.newestAt).toISOString()} (${fmtAge(s.newestAt)} ago)`);
    ctx.ui.notify(lines.join("\n"), "info");
}

function doDelete(ctx: ExtensionContext, parts: string[]): void {
    const id = Number(parts[1]);
    if (!Number.isFinite(id)) { ctx.ui.notify("Usage: /memory delete <id>", "error"); return; }
    const ok = memory.delete(id);
    ctx.ui.notify(ok ? `Deleted memory #${id}.` : `Memory #${id} not found.`, "info");
}

function doClear(ctx: ExtensionContext, parts: string[]): void {
    if (parts[1] !== "--confirm") {
        ctx.ui.notify("Wipes ALL memories. Run again with --confirm to proceed: /memory clear --confirm", "warning");
        return;
    }
    const n = memory.clear();
    ctx.ui.notify(`Cleared ${n} memories.`, "info");
}
