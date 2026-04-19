process.env["BOT_NAME"] = "_test_attach_file";

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import attachFileExtension from "../../.pi/extensions/attach_file.js";
import {
    drainPending,
    __resetPendingAttachmentsForTests,
} from "../core/pendingAttachments.js";
import { botDir } from "../core/paths.js";

// Minimal ExtensionAPI stub matching what attach_file needs. Captures the
// registered tool so tests can drive execute() directly without standing up
// a real Pi runtime.
interface RegisteredTool {
    name: string;
    parameters: unknown;
    execute: (
        toolCallId: string,
        params: { paths: string[] },
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { sessionManager: { getBranch(): ReadonlyArray<unknown> } },
    ) => Promise<unknown>;
}

function loadExtension(): RegisteredTool {
    const tools: RegisteredTool[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachFileExtension({
        registerTool: (def: unknown) => { tools.push(def as RegisteredTool); },
        // stubs — attach_file doesn't use these at module-init time
        on: () => {},
        registerCommand: () => {},
    } as any);
    const tool = tools.find((t) => t.name === "attach_file");
    if (!tool) throw new Error("attach_file tool was not registered by the extension");
    return tool;
}

function sessionWithOrigin(platform: string, channelId: string, senderId = "u1"): {
    getBranch(): ReadonlyArray<unknown>;
} {
    return {
        getBranch: () => [
            {
                type: "custom",
                customType: "transport-origin",
                data: {
                    platform,
                    channelId,
                    senderId,
                    senderDisplayName: "Test User",
                    timestamp: 1,
                },
            },
        ],
    };
}

describe("attach_file tool — outbound-contract plumbing", () => {
    const tmpFiles: string[] = [];

    beforeEach(() => {
        __resetPendingAttachmentsForTests();
    });

    afterEach(() => {
        while (tmpFiles.length > 0) {
            const f = tmpFiles.pop()!;
            try { fs.unlinkSync(f); } catch { /* ok */ }
        }
    });

    function mkTmp(content = "test content"): string {
        const p = path.join(os.tmpdir(), `ori2-attach-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
        fs.writeFileSync(p, content);
        tmpFiles.push(p);
        return p;
    }

    it("queues paths onto pendingAttachments for the current (platform, channelId)", async () => {
        const tool = loadExtension();
        const f1 = mkTmp("hello");
        const f2 = mkTmp("world");

        const result = await tool.execute(
            "call-1",
            { paths: [f1, f2] },
            new AbortController().signal,
            () => {},
            { sessionManager: sessionWithOrigin("telegram", "-100abc") },
        );

        const pending = drainPending("telegram", "-100abc");
        assert.equal(pending.length, 2);
        // Paths are normalized to absolute
        assert.equal(pending[0], path.resolve(f1));
        assert.equal(pending[1], path.resolve(f2));

        const details = (result as { details: { count: number; channel: string } }).details;
        assert.equal(details.count, 2);
        assert.equal(details.channel, "telegram:-100abc");
    });

    it("refuses to run when the session has no transport-origin (TUI case)", async () => {
        const tool = loadExtension();
        const f = mkTmp();

        await assert.rejects(
            () => tool.execute(
                "call-2",
                { paths: [f] },
                new AbortController().signal,
                () => {},
                { sessionManager: { getBranch: () => [] } },
            ),
            /transport-routed session/,
        );
    });

    it("refuses paths pointing at bot-private state (vault/secret/etc.)", async () => {
        const tool = loadExtension();
        const secret = path.join(botDir(), ".secret", "vault.json");
        // We don't need to actually create the file — the guard fires on path
        // resolution before stat().
        await assert.rejects(
            () => tool.execute(
                "call-3",
                { paths: [secret] },
                new AbortController().signal,
                () => {},
                { sessionManager: sessionWithOrigin("telegram", "-100abc") },
            ),
            /bot-private state/i,
        );
        // And nothing should have been queued.
        assert.deepEqual(drainPending("telegram", "-100abc"), []);
    });

    it("refuses substring-sensitive paths even outside botDir() (cross-bot probes)", async () => {
        const tool = loadExtension();
        await assert.rejects(
            () => tool.execute(
                "call-4",
                { paths: ["/tmp/my-vault.json"] },
                new AbortController().signal,
                () => {},
                { sessionManager: sessionWithOrigin("telegram", "-100abc") },
            ),
            /bot-private state/i,
        );
    });

    it("refuses nonexistent paths", async () => {
        const tool = loadExtension();
        await assert.rejects(
            () => tool.execute(
                "call-5",
                { paths: ["/tmp/does-not-exist-" + Date.now()] },
                new AbortController().signal,
                () => {},
                { sessionManager: sessionWithOrigin("telegram", "-100abc") },
            ),
            /cannot stat/i,
        );
    });

    it("refuses a directory instead of a file", async () => {
        const tool = loadExtension();
        await assert.rejects(
            () => tool.execute(
                "call-6",
                { paths: [os.tmpdir()] },
                new AbortController().signal,
                () => {},
                { sessionManager: sessionWithOrigin("telegram", "-100abc") },
            ),
            /not a regular file/i,
        );
    });

    it("atomicity: if ONE path fails validation, NO paths from the batch are enqueued", async () => {
        const tool = loadExtension();
        const good = mkTmp("ok");
        const bad = "/tmp/does-not-exist-" + Date.now();

        await assert.rejects(
            () => tool.execute(
                "call-7",
                { paths: [good, bad] },
                new AbortController().signal,
                () => {},
                { sessionManager: sessionWithOrigin("telegram", "-100atomic") },
            ),
        );
        // The good path was processed first — if we don't enforce
        // "validate all OR nothing", it would sneak into the queue.
        // We DO enqueue per-batch at the end; confirm nothing leaked.
        assert.deepEqual(drainPending("telegram", "-100atomic"), []);
    });
});
