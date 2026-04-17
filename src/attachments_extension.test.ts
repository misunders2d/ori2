process.env["BOT_NAME"] = "_test_attachments";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { botDir, botSubdir } from "./core/paths.js";

// -----------------------------------------------------------------------------
// Regression tests for the attachments extension's two agent tools
// (list_attachments, read_attachment). Covers:
//   - path-traversal guard (filename with .., /, absolute)
//   - disambiguation when the same filename exists under two platforms
//   - text extraction reuses the adapter pipeline (csv/json/plain)
//   - max_chars truncation
//   - binary fallback returns metadata, not bytes
// -----------------------------------------------------------------------------

function cleanTestDir(): void {
    const dir = botDir();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function writeAttachment(platform: string, filename: string, content: string | Buffer): string {
    const dir = path.join(botSubdir("incoming"), platform);
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, filename);
    if (typeof content === "string") fs.writeFileSync(full, content, "utf-8");
    else fs.writeFileSync(full, content);
    return full;
}

interface CapturedTool {
    name: string;
    execute: (id: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

async function loadTools(): Promise<CapturedTool[]> {
    const tools: CapturedTool[] = [];
    const api = {
        on: () => {},
        registerTool: (t: CapturedTool) => { tools.push(t); },
        registerCommand: () => {},
        sendUserMessage: () => {},
        appendEntry: () => {},
        events: { on: () => {}, emit: () => {} },
    };
    const factory = (await import("../.pi/extensions/attachments.js")).default;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory(api as any);
    return tools;
}

describe("attachments — list_attachments", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(cleanTestDir);

    it("returns an empty-list message when no attachments exist", async () => {
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "list_attachments")!;
        const out = await t.execute("c", {}, null, null, null);
        assert.match(out.content[0]!.text, /No attachments found/);
        assert.equal(out.details.count, 0);
    });

    it("lists files across all platforms when no platform filter is passed", async () => {
        writeAttachment("telegram", "report.csv", "a,b\n1,2\n");
        writeAttachment("slack", "notes.md", "# notes\n");

        const tools = await loadTools();
        const t = tools.find((x) => x.name === "list_attachments")!;
        const out = await t.execute("c", {}, null, null, null);
        assert.equal(out.details.count, 2);
        const entries = out.details.entries as Array<{ filename: string; platform: string }>;
        const names = entries.map((e) => e.filename).sort();
        assert.deepEqual(names, ["notes.md", "report.csv"]);
    });

    it("narrows to one platform when filter is passed", async () => {
        writeAttachment("telegram", "a.csv", "x");
        writeAttachment("slack", "b.csv", "y");
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "list_attachments")!;
        const out = await t.execute("c", { platform: "telegram" }, null, null, null);
        assert.equal(out.details.count, 1);
        const entries = out.details.entries as Array<{ filename: string }>;
        assert.equal(entries[0]!.filename, "a.csv");
    });

    it("returns most-recent-first ordering", async () => {
        // Write older file first, then sleep + write newer. mtime-based sort
        // should put the newer one first.
        writeAttachment("telegram", "old.csv", "x");
        await new Promise((r) => setTimeout(r, 20));
        writeAttachment("telegram", "new.csv", "y");

        const tools = await loadTools();
        const t = tools.find((x) => x.name === "list_attachments")!;
        const out = await t.execute("c", {}, null, null, null);
        const entries = out.details.entries as Array<{ filename: string }>;
        assert.equal(entries[0]!.filename, "new.csv");
        assert.equal(entries[1]!.filename, "old.csv");
    });

    it("honors the limit parameter", async () => {
        for (let i = 0; i < 5; i++) {
            writeAttachment("telegram", `f${i}.txt`, `content-${i}`);
            await new Promise((r) => setTimeout(r, 5));
        }
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "list_attachments")!;
        const out = await t.execute("c", { limit: 2 }, null, null, null);
        assert.equal(out.details.count, 2);
    });
});

describe("attachments — read_attachment path-safety", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(cleanTestDir);

    it("rejects filenames containing ..", async () => {
        writeAttachment("telegram", "ok.txt", "safe");
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "read_attachment")!;
        await assert.rejects(
            async () => { await t.execute("c", { filename: "../../etc/passwd" }, null, null, null); },
            /Invalid filename/,
        );
    });

    it("rejects absolute paths", async () => {
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "read_attachment")!;
        await assert.rejects(
            async () => { await t.execute("c", { filename: "/etc/passwd" }, null, null, null); },
            /Invalid filename/,
        );
    });

    it("rejects paths with forward slashes", async () => {
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "read_attachment")!;
        await assert.rejects(
            async () => { await t.execute("c", { filename: "subdir/file.txt" }, null, null, null); },
            /Invalid filename/,
        );
    });

    it("rejects a filename that doesn't match any attachment", async () => {
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "read_attachment")!;
        await assert.rejects(
            async () => { await t.execute("c", { filename: "ghost.csv" }, null, null, null); },
            /No attachment/,
        );
    });

    it("disambiguates ambiguous filenames (same name under two platforms) via platform arg", async () => {
        writeAttachment("telegram", "report.csv", "tg,data\n");
        writeAttachment("slack", "report.csv", "sl,data\n");
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "read_attachment")!;

        // Without platform → error asking to disambiguate.
        await assert.rejects(
            async () => { await t.execute("c", { filename: "report.csv" }, null, null, null); },
            /Ambiguous attachment/,
        );

        // With platform → reads the right one.
        const out = await t.execute("c", { filename: "report.csv", platform: "slack" }, null, null, null);
        assert.match(out.content[0]!.text, /sl,data/);
    });
});

describe("attachments — read_attachment content extraction", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(cleanTestDir);

    it("returns CSV content as text", async () => {
        writeAttachment("telegram", "data.csv", "name,count\nwidgets,42\n");
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "read_attachment")!;
        const out = await t.execute("c", { filename: "data.csv" }, null, null, null);
        assert.match(out.content[0]!.text, /widgets,42/);
        assert.equal(out.details.mime, "text/csv");
    });

    it("returns JSON content as text", async () => {
        writeAttachment("telegram", "cfg.json", '{"key":"value"}');
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "read_attachment")!;
        const out = await t.execute("c", { filename: "cfg.json" }, null, null, null);
        assert.match(out.content[0]!.text, /"key":"value"/);
    });

    it("truncates text at max_chars and notes the truncation", async () => {
        const big = "a".repeat(10_000);
        writeAttachment("telegram", "big.txt", big);
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "read_attachment")!;
        const out = await t.execute("c", { filename: "big.txt", max_chars: 500 }, null, null, null);
        assert.match(out.content[0]!.text, /truncated/);
        assert.equal(out.details.truncated, true);
        assert.equal(out.details.extractedChars, 10_000);
    });

    it("returns image metadata without inlining base64", async () => {
        // Minimal PNG header — enough to pass the mime-based dispatch.
        writeAttachment("telegram", "pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "read_attachment")!;
        const out = await t.execute("c", { filename: "pic.png" }, null, null, null);
        assert.match(out.content[0]!.text, /Image attachment/);
        assert.equal(out.details.kind, "image");
        // Base64 is NOT in the text reply — it's summarized.
        assert.ok(!out.content[0]!.text.includes("iVBORw0KGgo"));
    });

    it("returns binary-file summary for unknown binary formats", async () => {
        writeAttachment("telegram", "mystery.bin", Buffer.from([0xff, 0xfe, 0x00, 0x01]));
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "read_attachment")!;
        const out = await t.execute("c", { filename: "mystery.bin" }, null, null, null);
        assert.match(out.content[0]!.text, /Binary attachment/);
        assert.equal(out.details.kind, "binary");
    });
});

describe("attachments — housekeeping (sweep)", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(async () => {
        cleanTestDir();
        const mod = await import("../.pi/extensions/attachments.js");
        mod.__resetSweeperForTests();
    });

    it("sweepAttachments() deletes files older than ttlDays, leaves fresher ones alone", async () => {
        // Write one "old" file (mtime = 60 days ago) and one "new" (now).
        const oldPath = writeAttachment("telegram", "old.csv", "stale");
        const newPath = writeAttachment("telegram", "new.csv", "fresh");

        // Tweak mtime on the old file to 60 days ago.
        const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
        fs.utimesSync(oldPath, sixtyDaysAgo / 1000, sixtyDaysAgo / 1000);

        const { sweepAttachments } = await import("../.pi/extensions/attachments.js");
        const result = sweepAttachments({ ttlDays: 30, dryRun: false });

        assert.equal(result.scanned, 2);
        assert.equal(result.matched, 1);
        assert.ok(result.bytesFreed >= "stale".length);
        assert.equal(fs.existsSync(oldPath), false, "old file should be deleted");
        assert.equal(fs.existsSync(newPath), true, "new file should remain");
    });

    it("sweepAttachments() dry_run reports but does NOT delete", async () => {
        const oldPath = writeAttachment("telegram", "old.csv", "stale");
        const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
        fs.utimesSync(oldPath, sixtyDaysAgo / 1000, sixtyDaysAgo / 1000);

        const { sweepAttachments } = await import("../.pi/extensions/attachments.js");
        const result = sweepAttachments({ ttlDays: 30, dryRun: true });

        assert.equal(result.matched, 1);
        assert.equal(fs.existsSync(oldPath), true, "dry-run must not delete");
    });

    it("sweepAttachments() ttlDays=0 is a no-op (housekeeping disabled)", async () => {
        const oldPath = writeAttachment("telegram", "very_old.csv", "stale");
        const tenYearsAgo = Date.now() - 10 * 365 * 24 * 60 * 60 * 1000;
        fs.utimesSync(oldPath, tenYearsAgo / 1000, tenYearsAgo / 1000);

        const { sweepAttachments } = await import("../.pi/extensions/attachments.js");
        const result = sweepAttachments({ ttlDays: 0, dryRun: false });

        assert.equal(result.scanned, 0);
        assert.equal(result.matched, 0);
        assert.equal(fs.existsSync(oldPath), true, "ttlDays=0 must disable sweep");
    });

    it("sweep_attachments_now tool: admin can dry-run and preview what would be deleted", async () => {
        // Pre-seed an old file.
        const oldPath = writeAttachment("telegram", "old_report.csv", "x".repeat(1024));
        const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
        fs.utimesSync(oldPath, sixtyDaysAgo / 1000, sixtyDaysAgo / 1000);

        const tools = await loadTools();
        const t = tools.find((x) => x.name === "sweep_attachments_now");
        assert.ok(t, "sweep tool must be registered");

        // ctx without origin — extension treats that as "no channel" →
        // admin check short-circuits allows (like TUI operator).
        const ctx = {
            sessionManager: { getBranch: () => [] },
            hasUI: true,
        };
        const out = await t.execute("c", { dry_run: true }, null, null, ctx);
        assert.match(out.content[0]!.text, /dry-run/);
        assert.equal(out.details.matched, 1);
        assert.equal(fs.existsSync(oldPath), true, "dry_run must not delete");
    });

    it("sweep_attachments_now tool: ttl_days_override narrows the window", async () => {
        const fivedayPath = writeAttachment("telegram", "five_days_old.csv", "data");
        const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
        fs.utimesSync(fivedayPath, fiveDaysAgo / 1000, fiveDaysAgo / 1000);

        const tools = await loadTools();
        const t = tools.find((x) => x.name === "sweep_attachments_now")!;
        const ctx = { sessionManager: { getBranch: () => [] }, hasUI: true };
        const out = await t.execute("c", { ttl_days_override: 3, dry_run: false }, null, null, ctx);
        assert.equal(out.details.matched, 1);
        assert.equal(fs.existsSync(fivedayPath), false, "5-day-old file exceeds 3-day window — should be deleted");
    });

    it("sweep_attachments_now tool: rejects non-admin caller with a chat origin", async () => {
        const { getWhitelist: gw } = await import("./core/whitelist.js");
        gw().add("telegram", "alice", { roles: ["user"], addedBy: "test" });

        const tools = await loadTools();
        const t = tools.find((x) => x.name === "sweep_attachments_now")!;
        const ctx = {
            sessionManager: {
                getBranch: () => [{
                    type: "custom",
                    customType: "transport-origin",
                    data: { platform: "telegram", senderId: "alice", senderDisplayName: "Alice", channelId: "-100", timestamp: Date.now() },
                }],
            },
            hasUI: false,
        };
        await assert.rejects(
            async () => { await t.execute("c", {}, null, null, ctx); },
            /admin-only/i,
        );
    });
});
