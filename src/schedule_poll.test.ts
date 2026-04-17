process.env["BOT_NAME"] = "_test_schedule_poll";

import { describe, it, before, beforeEach, after, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import schedule from "node-schedule";
import { botDir } from "./core/paths.js";
import { clearRegistryForTests } from "./core/singletons.js";
import { getKVCache, __resetKVCacheForTests } from "./core/kvCache.js";

/**
 * Cancel every node-schedule job registered during this test process.
 * schedule_poll uses real cron scheduling — without teardown, a `*\/30 * * * * *`
 * poll fires ~30s after registration (inside the test process), spawning
 * `pi -p` subprocesses and keeping the event loop alive forever. Pi's own
 * test runner would give up and kill us.
 */
function cancelAllScheduledJobs(): void {
    for (const name of Object.keys(schedule.scheduledJobs)) {
        schedule.scheduledJobs[name]?.cancel();
    }
}

// =============================================================================
// schedule_poll + mark_poll_done tests.
//
// The signalling path between subprocess and parent goes through kvCache,
// specifically namespace "poll-control". Subprocess's mark_poll_done writes
// a done-signal; parent's fireJob reads it before spawning (short-circuit
// to finalize) and after spawn exit (immediate finalize without next tick).
//
// We test the CONTROL-CHANNEL semantics directly — calling the exported
// tool handlers with a fake ExtensionContext and verifying kvCache state.
// Full fire loop is out of scope (spawns real pi -p, requires credentials).
// =============================================================================

function cleanTestDir(): void {
    __resetKVCacheForTests();
    const dir = botDir();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

interface CapturedTool {
    name: string;
    execute: (
        id: string,
        params: Record<string, unknown>,
        signal: unknown,
        onUpdate: unknown,
        ctx: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

async function loadSchedulerTools(): Promise<CapturedTool[]> {
    const tools: CapturedTool[] = [];
    const api = {
        on: () => {},
        registerTool: (t: CapturedTool) => { tools.push(t); },
        registerCommand: () => {},
        sendUserMessage: () => {},
        appendEntry: () => {},
        events: { on: () => {}, emit: () => {} },
    };
    const factory = (await import("../.pi/extensions/scheduler.js")).default;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory(api as any);
    return tools;
}

function makeCtx(sessionFile?: string) {
    return {
        sessionManager: {
            getBranch: () => [],
            getSessionFile: () => sessionFile,
        },
        hasUI: true,
        cwd: process.cwd(),
        ui: { notify: () => {} },
    };
}

describe("schedule_poll — control channel (kvCache)", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(() => {
        cancelAllScheduledJobs();
        cleanTestDir();
        clearRegistryForTests();
    });
    afterEach(cancelAllScheduledJobs);

    it("mark_poll_done writes a done-signal to kvCache's poll-control namespace", async () => {
        const tools = await loadSchedulerTools();
        const mark = tools.find((t) => t.name === "mark_poll_done");
        assert.ok(mark, "mark_poll_done tool must be registered");

        const out = await mark.execute(
            "c",
            { poll_id: "poll_test_123", final_result: "Report downloaded successfully." },
            null,
            null,
            makeCtx(),
        );
        assert.match(out.content[0]!.text, /marked done/i);

        // Verify kvCache has the done-signal.
        const signal = getKVCache().get<{ done: true; result: string; markedAt: number }>("poll-control", "poll_test_123");
        assert.ok(signal, "done-signal must be present in kvCache");
        assert.equal(signal!.done, true);
        assert.equal(signal!.result, "Report downloaded successfully.");
        assert.ok(typeof signal!.markedAt === "number");
    });

    it("mark_poll_done is idempotent — second call overwrites with new result", async () => {
        const tools = await loadSchedulerTools();
        const mark = tools.find((t) => t.name === "mark_poll_done")!;

        await mark.execute("c", { poll_id: "p1", final_result: "first" }, null, null, makeCtx());
        await mark.execute("c", { poll_id: "p1", final_result: "second (revised)" }, null, null, makeCtx());

        const signal = getKVCache().get<{ result: string }>("poll-control", "p1");
        assert.equal(signal!.result, "second (revised)");
    });

    it("different poll_ids get independent control entries", async () => {
        const tools = await loadSchedulerTools();
        const mark = tools.find((t) => t.name === "mark_poll_done")!;

        await mark.execute("c", { poll_id: "poll_a", final_result: "A done" }, null, null, makeCtx());
        await mark.execute("c", { poll_id: "poll_b", final_result: "B done" }, null, null, makeCtx());

        const cache = getKVCache();
        assert.equal(cache.get<{ result: string }>("poll-control", "poll_a")!.result, "A done");
        assert.equal(cache.get<{ result: string }>("poll-control", "poll_b")!.result, "B done");
    });
});

describe("schedule_poll — persisted meta", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(() => {
        cancelAllScheduledJobs();
        cleanTestDir();
        clearRegistryForTests();
    });
    afterEach(cancelAllScheduledJobs);

    it("persists a poll job with job_type='poll', cron from every_seconds, and poll_max_attempts", async () => {
        const tools = await loadSchedulerTools();
        const sched = tools.find((t) => t.name === "schedule_poll");
        assert.ok(sched, "schedule_poll tool must be registered");

        const out = await sched.execute(
            "c",
            {
                poll_id: "poll_sp_report_xyz",
                every_seconds: 30,
                check_instruction: "Check SP-API report id REP123 status. If DONE, call mark_poll_done.",
                max_attempts: 60,
            },
            null,
            null,
            makeCtx(),
        );

        assert.match(out.content[0]!.text, /Poll 'poll_sp_report_xyz' scheduled/);
        assert.equal(out.details.every_seconds, 30);
        assert.equal(out.details.max_attempts, 60);

        // Verify the meta file.
        const metaPath = path.join(botDir(), "jobs", "poll_sp_report_xyz.json");
        assert.ok(fs.existsSync(metaPath), "job meta must be persisted to data/<bot>/jobs/");
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        assert.equal(meta.job_type, "poll");
        assert.equal(meta.cron, "*/30 * * * * *"); // 6-field, seconds-position
        assert.equal(meta.poll_max_attempts, 60);
        assert.equal(meta.poll_attempts, 0);
    });

    it("rejects a duplicate poll_id while the first is active", async () => {
        const tools = await loadSchedulerTools();
        const sched = tools.find((t) => t.name === "schedule_poll")!;
        await sched.execute(
            "c",
            { poll_id: "dup_id", every_seconds: 30, check_instruction: "ping" },
            null, null, makeCtx(),
        );
        await assert.rejects(
            async () => {
                await sched.execute(
                    "c",
                    { poll_id: "dup_id", every_seconds: 60, check_instruction: "pong" },
                    null, null, makeCtx(),
                );
            },
            /already active/i,
        );
    });

    it("rejects every_seconds outside [10, 3600]", async () => {
        const tools = await loadSchedulerTools();
        const sched = tools.find((t) => t.name === "schedule_poll")!;
        // TypeBox validation happens inside Pi's runtime not in the raw
        // execute() here — but our execute call would still accept the value
        // and it'd produce an invalid cron. Best-effort: verify that 0 at
        // least produces a non-scheduling result.
        await assert.rejects(
            async () => {
                await sched.execute(
                    "c",
                    { poll_id: "tight", every_seconds: 0, check_instruction: "spam" },
                    null, null, makeCtx(),
                );
            },
            /Invalid cron|cron/i,
        );
    });
});

describe("schedule_poll — delivery target", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(() => {
        cancelAllScheduledJobs();
        cleanTestDir();
        clearRegistryForTests();
    });
    afterEach(cancelAllScheduledJobs);

    it("captures deliver_to when explicitly passed", async () => {
        const tools = await loadSchedulerTools();
        const sched = tools.find((t) => t.name === "schedule_poll")!;

        await sched.execute(
            "c",
            {
                poll_id: "poll_routed",
                every_seconds: 30,
                check_instruction: "check X",
                deliver_to: { platform: "telegram", channelId: "-100abc" },
            },
            null, null, makeCtx(),
        );

        const metaPath = path.join(botDir(), "jobs", "poll_routed.json");
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        assert.equal(meta.deliverTarget.platform, "telegram");
        assert.equal(meta.deliverTarget.channelId, "-100abc");
    });
});
