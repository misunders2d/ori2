import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
    getDnaCatalog,
    pullDnaFromFriend,
    applyDna,
    rollbackToSnapshot,
    listSnapshots,
    listImports,
    type ApplyStrategy,
} from "../../src/a2a/dna.js";
import { discoverAgentCard } from "../../src/a2a/client.js";
import { getFriends } from "../../src/a2a/friends.js";
import { getA2AServerHandle } from "../../src/a2a/server.js";
import { currentOrigin } from "../../src/core/identity.js";
import { getWhitelist } from "../../src/core/whitelist.js";
import { registerActionDescriber } from "./admin_gate.js";

// =============================================================================
// .pi/extensions/dna.ts — operator + LLM surface for DNA exchange.
//
// Hands off to src/a2a/dna.ts for everything load-bearing (catalog, packaging,
// staging, snapshots, apply/rollback). This file is the surface area the agent
// and the operator see.
// =============================================================================

function callerLabel(ctx: ExtensionContext): string {
    const origin = currentOrigin(ctx.sessionManager);
    if (!origin) return "cli";
    return `${origin.platform}:${origin.senderId}`;
}

function isAdminCaller(ctx: ExtensionContext): boolean {
    const origin = currentOrigin(ctx.sessionManager);
    if (!origin) return true;
    return getWhitelist().isAdmin(origin.platform, origin.senderId);
}

/** After register / unregister, refresh the agent card so peers see the new dna:* skills. */
function refreshCardIfRunning(): void {
    const handle = getA2AServerHandle();
    if (handle) handle.refreshAgentCard({});
}

export default function (pi: ExtensionAPI) {
    // Register manifest-aware action describer so admin sees what files +
    // source bot they're approving when apply_dna stages — closes the
    // audit-flagged "admin sees only the token" gap.
    registerActionDescriber("apply_dna", (args) => {
        const a = args as { import_id?: string; strategy?: string };
        if (!a.import_id) return null;
        const imp = listImports().find((i) => i.id === a.import_id);
        if (!imp) return `Import id: ${a.import_id} (NOT FOUND in staging — refusing would be safe)`;
        const m = imp.manifest;
        if (!m) return `Import id: ${a.import_id}\nManifest: (missing — apply will likely fail)`;
        const filesPreview = m.files.slice(0, 20).map((f) => `    ${f.path}  (${f.size}B  sha256:${f.sha256.slice(0, 12)}…)`).join("\n");
        const more = m.files.length > 20 ? `\n    …and ${m.files.length - 20} more files` : "";
        return [
            `DNA feature:    ${m.feature_id}  v${m.feature_version}`,
            `Source bot:     ${m.source_bot} (agent ${m.source_agent_id})`,
            `Description:    ${m.description}`,
            `Tags:           ${m.tags.join(", ") || "(none)"}`,
            `Strategy:       ${a.strategy ?? "abort"}  (abort = refuse on conflict; overwrite = clobber local; rename = keep both)`,
            `Files (${m.files.length}):`,
            filesPreview + more,
        ].join("\n");
    });

    registerActionDescriber("rollback_dna", (args) => {
        const a = args as { snapshot_id?: string };
        if (!a.snapshot_id) return null;
        return `Rollback to snapshot: ${a.snapshot_id}\n` +
               `This restores .pi/ from the snapshot (overwrites whatever's there now).`;
    });

    // -------------------------- LLM tools --------------------------

    pi.registerTool({
        name: "register_dna_feature",
        label: "Register DNA Feature",
        description:
            "Declare a named feature this bot can share via DNA exchange. Files MUST live under .pi/extensions/, " +
            ".pi/skills/, or .pi/prompts/ — the catalog rejects anything else. The feature appears as a " +
            "`dna:<id>` skill in the agent card so peers can discover it.",
        parameters: Type.Object({
            id: Type.String({ description: "Unique feature id (no spaces, lowercase recommended). Must NOT start with 'dna:'." }),
            description: Type.String({ description: "What the feature does + any verification context (e.g. 'verified working on AmazonBot 30 days')" }),
            files: Type.Array(Type.String(), { description: "Relative paths (under .pi/) bundled by this feature" }),
            tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for discovery (e.g. ['integration', 'crm'])" })),
            version: Type.Optional(Type.String({ description: "Feature version. Default '1.0.0'." })),
            share_with: Type.Optional(Type.Array(Type.String(), { description: "Allow list of friend names. Default ['*'] = all friends. [] = nobody (private)." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const f = getDnaCatalog().register(params.id, {
                description: params.description,
                files: params.files,
                ...(params.tags !== undefined ? { tags: params.tags } : {}),
                ...(params.version !== undefined ? { version: params.version } : {}),
                ...(params.share_with !== undefined ? { share_with: params.share_with } : {}),
                registered_by: callerLabel(ctx),
            });
            refreshCardIfRunning();
            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Feature "${params.id}" registered (${f.files.length} file${f.files.length === 1 ? "" : "s"}, ` +
                            `share_with=[${f.share_with.join(", ")}]). Now visible to peers as dna:${params.id} in our agent card.`,
                    },
                ],
                details: { id: params.id, files: f.files, share_with: f.share_with },
            };
        },
    });

    pi.registerTool({
        name: "unregister_dna_feature",
        label: "Unregister DNA Feature",
        description: "Remove a feature from the catalog. Does NOT delete the underlying files — only stops advertising the feature to peers.",
        parameters: Type.Object({
            id: Type.String({ description: "Feature id to remove" }),
        }),
        async execute(_id, params) {
            const ok = getDnaCatalog().unregister(params.id);
            if (ok) refreshCardIfRunning();
            return {
                content: [{ type: "text", text: ok ? `Removed "${params.id}".` : `Feature "${params.id}" not in catalog.` }],
                details: { id: params.id, removed: ok },
            };
        },
    });

    pi.registerTool({
        name: "list_dna_features",
        label: "List Local DNA Features",
        description: "List the DNA features this bot exposes (our catalog).",
        parameters: Type.Object({}),
        async execute() {
            const all = getDnaCatalog().list();
            if (all.length === 0) return { content: [{ type: "text", text: "No DNA features registered." }], details: { count: 0 } };
            const lines = all.map((f) =>
                `  ${f.id.padEnd(28)} v${f.version}  files=${f.files.length}  share_with=[${f.share_with.join(", ")}]`,
            );
            return {
                content: [{ type: "text", text: `Local DNA catalog (${all.length}):\n\n${lines.join("\n")}` }],
                details: { count: all.length, features: all.map((f) => ({ id: f.id, version: f.version, share_with: f.share_with })) },
            };
        },
    });

    pi.registerTool({
        name: "list_friend_dna_features",
        label: "List Friend's DNA Features",
        description: "Discover what DNA features a friend exposes by GETting their agent card and filtering for dna:* skills.",
        parameters: Type.Object({
            friend_name: Type.String({ description: "Friend's local name" }),
        }),
        async execute(_id, params) {
            const friend = getFriends().get(params.friend_name);
            if (!friend) throw new Error(`unknown friend: ${params.friend_name}`);
            const card = await discoverAgentCard(friend.base_url);
            const dna = card.skills.filter((s) => s.id.startsWith("dna:")).map((s) => ({
                feature_id: s.id.slice("dna:".length),
                description: s.description,
                tags: s.tags ?? [],
            }));
            if (dna.length === 0) {
                return { content: [{ type: "text", text: `${params.friend_name} exposes no DNA features.` }], details: { count: 0 } };
            }
            const lines = dna.map((d) => `  ${d.feature_id.padEnd(28)}  ${d.description}`);
            return {
                content: [{ type: "text", text: `${params.friend_name}'s DNA features (${dna.length}):\n\n${lines.join("\n")}` }],
                details: { count: dna.length, features: dna },
            };
        },
    });

    pi.registerTool({
        name: "pull_dna",
        label: "Pull DNA Feature From Friend",
        description:
            "Download a friend's DNA feature, stage it, and report a conflict summary. Does NOT touch .pi/. " +
            "Operator must call apply_dna(import_id) afterward to actually apply.",
        parameters: Type.Object({
            friend_name: Type.String({ description: "Friend's local name" }),
            feature_id: Type.String({ description: "Feature id (without 'dna:' prefix)" }),
        }),
        async execute(_id, params) {
            const result = await pullDnaFromFriend(params.friend_name, params.feature_id);
            const conflicts = result.conflicts.filter((c) => c.kind === "differs");
            const newFiles = result.conflicts.filter((c) => c.kind === "missing");
            const noOps = result.conflicts.filter((c) => c.kind === "identical");
            const summary = [
                `Pulled "${params.feature_id}" from ${params.friend_name} → import_id=${result.importId}`,
                `  files in feature: ${result.manifest.files.length}`,
                `  new (no conflict):   ${newFiles.length}`,
                `  identical (no-op):   ${noOps.length}`,
                `  WOULD OVERWRITE:     ${conflicts.length}${conflicts.length > 0 ? "  [" + conflicts.map((c) => c.path).join(", ") + "]" : ""}`,
                "",
                conflicts.length > 0
                    ? `Apply with: apply_dna(import_id="${result.importId}", strategy="overwrite") OR strategy="rename"`
                    : `Apply with: apply_dna(import_id="${result.importId}")`,
            ].join("\n");
            return { content: [{ type: "text", text: summary }], details: { import_id: result.importId, conflicts: result.conflicts } };
        },
    });

    pi.registerTool({
        name: "apply_dna",
        label: "Apply Staged DNA Import",
        description:
            "Apply a staged DNA import. Snapshots .pi/ first, copies the staged files in per strategy, runs " +
            "`npm test`, and AUTO-ROLLS-BACK from the snapshot if tests fail. After success the operator should " +
            "/reload Pi to pick up the new extensions.",
        parameters: Type.Object({
            import_id: Type.String({ description: "Import id from pull_dna" }),
            strategy: Type.Optional(Type.String({ description: "abort (default) | overwrite | rename" })),
        }),
        async execute(_id, params) {
            const strategy = (params.strategy as ApplyStrategy | undefined) ?? "abort";
            const result = await applyDna(params.import_id, strategy);
            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Apply ${result.status}.\n` +
                            `  snapshot_id:  ${result.snapshotId}\n` +
                            `  applied:      ${result.appliedFiles.length} files\n` +
                            (result.renamedFiles?.length ? `  renamed:      ${result.renamedFiles.length} local file(s)\n` : "") +
                            (result.rollbackReason ? `  reason:       ${result.rollbackReason}\n` : "") +
                            (result.status === "applied"
                                ? "Run /reload to load the new extensions."
                                : ""),
                    },
                ],
                details: result as unknown as Record<string, unknown>,
            };
        },
    });

    pi.registerTool({
        name: "list_dna_imports",
        label: "List Staged DNA Imports",
        description: "List incoming DNA imports awaiting apply.",
        parameters: Type.Object({}),
        async execute() {
            const all = listImports();
            if (all.length === 0) return { content: [{ type: "text", text: "No staged DNA imports." }], details: { count: 0 } };
            const lines = all.map((i) => `  ${i.id}  ${i.manifest?.feature_id ?? "(unknown)"}  from=${i.manifest?.source_bot ?? "?"}`);
            return { content: [{ type: "text", text: `Staged imports (${all.length}):\n\n${lines.join("\n")}` }], details: { count: all.length, imports: all } };
        },
    });

    pi.registerTool({
        name: "list_dna_snapshots",
        label: "List DNA Snapshots",
        description: "List rollback points (snapshots taken before each apply). Most recent first.",
        parameters: Type.Object({}),
        async execute() {
            const all = listSnapshots();
            if (all.length === 0) return { content: [{ type: "text", text: "No snapshots." }], details: { count: 0 } };
            const lines = all.map((s) => {
                const kb = (s.sizeBytes / 1024).toFixed(1);
                return `  ${s.id}  ${kb}KB  created=${new Date(s.createdAt).toISOString()}`;
            });
            return { content: [{ type: "text", text: `Snapshots (${all.length}):\n\n${lines.join("\n")}` }], details: { count: all.length } };
        },
    });

    pi.registerTool({
        name: "rollback_dna",
        label: "Rollback DNA — Restore Snapshot",
        description: "Restore .pi/ from a snapshot. Operator should /reload Pi afterward.",
        parameters: Type.Object({
            snapshot_id: Type.String({ description: "Snapshot id from list_dna_snapshots" }),
        }),
        async execute(_id, params) {
            await rollbackToSnapshot(params.snapshot_id);
            return {
                content: [{ type: "text", text: `Restored .pi/ from ${params.snapshot_id}. Run /reload to pick up the change.` }],
                details: { snapshot_id: params.snapshot_id },
            };
        },
    });

    // -------------------------- slash commands --------------------------

    pi.registerCommand("dna", {
        description: "DNA exchange — share evolved features with peer ori2 instances. Run /dna help for full reference.",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "help").toLowerCase();
            switch (sub) {
                case "help":      return doHelp(ctx);
                case "list":      return doList(ctx);
                case "staged":    return doStaged(ctx);
                case "snapshots": return doSnapshots(ctx);
                case "feature":   return doFeature(ctx, parts);
                case "inspect":   return doInspect(ctx, parts);
                case "pull":      return await doPull(ctx, parts);
                case "apply":     return await doApply(ctx, parts);
                case "rollback":  return await doRollback(ctx, parts);
                default:
                    ctx.ui.notify(`Unknown /dna subcommand: ${sub}. Run /dna help.`, "error");
            }
        },
    });
}

// -------------------------- slash command handlers --------------------------

function doHelp(ctx: ExtensionContext): void {
    ctx.ui.notify([
        "═════════════════════════════════════════════════════════════",
        "  /dna — DNA exchange (share evolved features with peers)",
        "═════════════════════════════════════════════════════════════",
        "",
        "VIEW",
        "  /dna list                          — local features we expose",
        "  /dna staged                        — incoming imports awaiting apply",
        "  /dna snapshots                     — rollback points",
        "  /dna inspect <id>                  — show local feature definition",
        "",
        "MANAGE LOCAL CATALOG (admin)",
        "  /dna feature add <id> <files...> [--description \"...\"] [--tags a,b] [--share-with name,name|*]",
        "  /dna feature remove <id>",
        "",
        "EXCHANGE WITH PEERS (admin)",
        "  /dna pull <friend> <feature-id>    — download + stage (no apply)",
        "  /dna apply <import-id> [strategy]  — apply staged (abort/overwrite/rename, default abort)",
        "  /dna rollback <snapshot-id>        — restore .pi/ from snapshot",
        "",
        "═════════════════════════════════════════════════════════════",
    ].join("\n"), "info");
}

function doList(ctx: ExtensionContext): void {
    const all = getDnaCatalog().list();
    if (all.length === 0) { ctx.ui.notify("No DNA features registered.", "info"); return; }
    const lines = ["Local DNA catalog:", ""];
    for (const f of all) {
        lines.push(`  ${f.id.padEnd(28)} v${f.version}  files=${f.files.length}  share_with=[${f.share_with.join(", ")}]`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
}

function doStaged(ctx: ExtensionContext): void {
    const all = listImports();
    if (all.length === 0) { ctx.ui.notify("No staged DNA imports.", "info"); return; }
    const lines = ["Staged imports:", ""];
    for (const i of all) {
        const fid = i.manifest?.feature_id ?? "(unknown)";
        const from = i.manifest?.source_bot ?? "?";
        lines.push(`  ${i.id}  feature=${fid}  from=${from}  files=${i.manifest?.files.length ?? 0}`);
    }
    lines.push("", "Apply with: /dna apply <import-id> [overwrite|rename]");
    ctx.ui.notify(lines.join("\n"), "info");
}

function doSnapshots(ctx: ExtensionContext): void {
    const all = listSnapshots();
    if (all.length === 0) { ctx.ui.notify("No snapshots.", "info"); return; }
    const lines = ["Rollback snapshots (newest first):", ""];
    for (const s of all) {
        const kb = (s.sizeBytes / 1024).toFixed(1);
        lines.push(`  ${s.id}  ${kb}KB  ${new Date(s.createdAt).toISOString()}`);
    }
    lines.push("", "Restore with: /dna rollback <snapshot-id>");
    ctx.ui.notify(lines.join("\n"), "info");
}

function doInspect(ctx: ExtensionContext, parts: string[]): void {
    const id = parts[1];
    if (!id) { ctx.ui.notify("Usage: /dna inspect <id>", "error"); return; }
    const f = getDnaCatalog().get(id);
    if (!f) { ctx.ui.notify(`Feature "${id}" not in catalog.`, "error"); return; }
    ctx.ui.notify([
        `Feature: ${id}`,
        `  description:    ${f.description}`,
        `  version:        ${f.version}`,
        `  tags:           [${(f.tags ?? []).join(", ")}]`,
        `  share_with:     [${f.share_with.join(", ")}]`,
        `  registered_by:  ${f.registered_by}`,
        `  registered_at:  ${new Date(f.registered_at).toISOString()}`,
        `  files (${f.files.length}):`,
        ...f.files.map((p) => `    - ${p}`),
    ].join("\n"), "info");
}

function doFeature(ctx: ExtensionContext, parts: string[]): void {
    if (!isAdminCaller(ctx)) { ctx.ui.notify("/dna feature is admin-only.", "error"); return; }
    const op = parts[1];
    if (op === "add") return doFeatureAdd(ctx, parts);
    if (op === "remove") return doFeatureRemove(ctx, parts);
    ctx.ui.notify("Usage: /dna feature add <id> <files...> [flags]   |   remove <id>", "error");
}

function doFeatureAdd(ctx: ExtensionContext, parts: string[]): void {
    // parts: ["feature", "add", <id>, <file1>, <file2>, ..., flags...]
    const id = parts[2];
    if (!id) { ctx.ui.notify("Usage: /dna feature add <id> <file1> [file2 ...] [--description ...] [--tags a,b] [--share-with ...]", "error"); return; }
    const files: string[] = [];
    let description = `Feature "${id}"`;
    let tags: string[] | undefined;
    let shareWith: string[] | undefined;
    for (let i = 3; i < parts.length; i++) {
        const p = parts[i]!;
        if (p === "--description" && i + 1 < parts.length) { description = parts[i + 1]!; i++; }
        else if (p === "--tags" && i + 1 < parts.length) { tags = parts[i + 1]!.split(",").map((t) => t.trim()).filter(Boolean); i++; }
        else if (p === "--share-with" && i + 1 < parts.length) { shareWith = parts[i + 1]!.split(",").map((t) => t.trim()).filter(Boolean); i++; }
        else if (p === "--private") { shareWith = []; }
        else if (!p.startsWith("--")) { files.push(p); }
    }
    if (files.length === 0) { ctx.ui.notify("Need at least one file path.", "error"); return; }
    try {
        const f = getDnaCatalog().register(id, {
            description,
            files,
            ...(tags !== undefined ? { tags } : {}),
            ...(shareWith !== undefined ? { share_with: shareWith } : {}),
            registered_by: callerLabel(ctx),
        });
        refreshCardIfRunning();
        ctx.ui.notify(`Registered "${id}" (${f.files.length} files, share_with=[${f.share_with.join(", ")}]).`, "info");
    } catch (e) {
        ctx.ui.notify(`Register failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
}

function doFeatureRemove(ctx: ExtensionContext, parts: string[]): void {
    const id = parts[2];
    if (!id) { ctx.ui.notify("Usage: /dna feature remove <id>", "error"); return; }
    const ok = getDnaCatalog().unregister(id);
    if (ok) refreshCardIfRunning();
    ctx.ui.notify(ok ? `Removed "${id}".` : `Feature "${id}" not in catalog.`, "info");
}

async function doPull(ctx: ExtensionContext, parts: string[]): Promise<void> {
    if (!isAdminCaller(ctx)) { ctx.ui.notify("/dna pull is admin-only.", "error"); return; }
    const friend = parts[1]; const feature = parts[2];
    if (!friend || !feature) { ctx.ui.notify("Usage: /dna pull <friend> <feature-id>", "error"); return; }
    try {
        const r = await pullDnaFromFriend(friend, feature);
        const conflicts = r.conflicts.filter((c) => c.kind === "differs");
        const newF = r.conflicts.filter((c) => c.kind === "missing");
        const noOps = r.conflicts.filter((c) => c.kind === "identical");
        ctx.ui.notify([
            `Pulled "${feature}" from ${friend}.`,
            `  import_id:           ${r.importId}`,
            `  files in feature:    ${r.manifest.files.length}`,
            `  new (no conflict):   ${newF.length}`,
            `  identical (no-op):   ${noOps.length}`,
            `  WOULD OVERWRITE:     ${conflicts.length}${conflicts.length > 0 ? "  [" + conflicts.map((c) => c.path).join(", ") + "]" : ""}`,
            "",
            conflicts.length > 0
                ? `Apply with: /dna apply ${r.importId} overwrite   OR   /dna apply ${r.importId} rename`
                : `Apply with: /dna apply ${r.importId}`,
        ].join("\n"), "info");
    } catch (e) {
        ctx.ui.notify(`Pull failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
}

async function doApply(ctx: ExtensionContext, parts: string[]): Promise<void> {
    if (!isAdminCaller(ctx)) { ctx.ui.notify("/dna apply is admin-only.", "error"); return; }
    const importId = parts[1];
    if (!importId) { ctx.ui.notify("Usage: /dna apply <import-id> [abort|overwrite|rename]", "error"); return; }
    const strategy = (parts[2] as ApplyStrategy | undefined) ?? "abort";
    try {
        const r = await applyDna(importId, strategy);
        ctx.ui.notify([
            `Apply ${r.status}.`,
            `  snapshot_id:  ${r.snapshotId}`,
            `  applied:      ${r.appliedFiles.length} files`,
            ...(r.renamedFiles?.length ? [`  renamed:      ${r.renamedFiles.length} local file(s)`] : []),
            ...(r.rollbackReason ? [`  reason:       ${r.rollbackReason}`] : []),
            r.status === "applied" ? "" : "",
            r.status === "applied" ? "Run /reload to load the new extensions." : "",
        ].filter(Boolean).join("\n"), r.status === "applied" ? "info" : "warning");
    } catch (e) {
        ctx.ui.notify(`Apply failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
}

async function doRollback(ctx: ExtensionContext, parts: string[]): Promise<void> {
    if (!isAdminCaller(ctx)) { ctx.ui.notify("/dna rollback is admin-only.", "error"); return; }
    const snapshotId = parts[1];
    if (!snapshotId) { ctx.ui.notify("Usage: /dna rollback <snapshot-id>", "error"); return; }
    try {
        await rollbackToSnapshot(snapshotId);
        ctx.ui.notify(`Restored .pi/ from ${snapshotId}. Run /reload to pick up the change.`, "info");
    } catch (e) {
        ctx.ui.notify(`Rollback failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
}
