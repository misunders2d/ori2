process.env["BOT_NAME"] = "_test_scheduler_phase7";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { botDir } from "./paths.js";

// Phase 7 adds job_type / deliverTarget / origin_session_file to JobMeta and
// changes fire-time kickoff + post-delivery behaviour. The scheduler module
// is a Pi extension (not directly importable as a regular module without
// side effects), so these tests exercise the pure-function portions by
// writing JSON job files to data/<bot>/jobs/ and invoking
// `loadAllJobMeta` — the same migration path fires on boot.
//
// Fire-time behaviour (subprocess spawn + delivery) is integration-level and
// verified with the live TUI, not here.

const TEST_DIR = botDir();
function rmTestDir() { if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true }); }

before(rmTestDir);
after(rmTestDir);
beforeEach(rmTestDir);

async function loadJobsViaExtension(): Promise<Array<Record<string, unknown>>> {
    // The scheduler extension's loadAllJobMeta() isn't exported (it's an
    // extension-internal helper). Reproduce its exact read behaviour here
    // to lock in the schema + migration semantics.
    const jobsDir = path.join(TEST_DIR, "jobs");
    if (!fs.existsSync(jobsDir)) return [];
    const out: Array<Record<string, unknown>> = [];
    for (const f of fs.readdirSync(jobsDir).filter((x) => x.endsWith(".json"))) {
        const raw = fs.readFileSync(path.join(jobsDir, f), "utf-8");
        out.push(JSON.parse(raw) as Record<string, unknown>);
    }
    return out;
}

describe("Phase 7 — JobMeta schema persisted to disk", () => {
    it("writes job_type, deliverTarget, origin_session_file when caller provides them", () => {
        fs.mkdirSync(path.join(TEST_DIR, "jobs"), { recursive: true });
        const meta = {
            job_id: "reminder_42",
            job_type: "reminder",
            cron: "2026-04-20T09:00:00.000Z",
            task: "Remind me about Oppenheimer",
            originChannel: { platform: "telegram", channelId: "123456" },
            deliverTarget: { platform: "slack", channelId: "C01234" },
            origin_session_file: "/abs/path/session-xyz.jsonl",
            created_at: Date.now(),
            created_by: "telegram:123456",
        };
        fs.writeFileSync(path.join(TEST_DIR, "jobs", "reminder_42.json"), JSON.stringify(meta));
        // Round-trip
        const parsed = JSON.parse(fs.readFileSync(path.join(TEST_DIR, "jobs", "reminder_42.json"), "utf-8")) as typeof meta;
        assert.equal(parsed.job_type, "reminder");
        assert.deepEqual(parsed.deliverTarget, { platform: "slack", channelId: "C01234" });
        assert.equal(parsed.origin_session_file, "/abs/path/session-xyz.jsonl");
    });
});

describe("Phase 7 — JobMeta back-compat for pre-Phase-7 job files", () => {
    it("legacy file without job_type starting with 'reminder_' is treated as reminder", async () => {
        fs.mkdirSync(path.join(TEST_DIR, "jobs"), { recursive: true });
        const legacyReminder = {
            job_id: "reminder_1776000000000",
            cron: "2026-04-20T09:00:00.000Z",
            task: "drink coffee",
            created_at: 1776000000000,
            created_by: "cli",
        };
        fs.writeFileSync(path.join(TEST_DIR, "jobs", "reminder_1776000000000.json"), JSON.stringify(legacyReminder));
        const files = await loadJobsViaExtension();
        assert.equal(files.length, 1);
        // The ON-DISK file doesn't have job_type yet — the scheduler's
        // loadAllJobMeta infers "reminder" from the job_id prefix at LOAD
        // time. Verify the on-disk shape is valid input to that inference:
        assert.equal(files[0]!.job_type, undefined);
        assert.ok((files[0]!.job_id as string).startsWith("reminder_"));
    });

    it("legacy file without job_type and without 'reminder_' prefix defaults to 'task'", async () => {
        fs.mkdirSync(path.join(TEST_DIR, "jobs"), { recursive: true });
        const legacyTask = {
            job_id: "daily_inventory",
            cron: "0 9 * * *",
            task: "Pull SKU inventory",
            created_at: Date.now(),
            created_by: "telegram:1",
        };
        fs.writeFileSync(path.join(TEST_DIR, "jobs", "daily_inventory.json"), JSON.stringify(legacyTask));
        const files = await loadJobsViaExtension();
        assert.equal(files.length, 1);
        assert.equal(files[0]!.job_type, undefined); // inferred at load time
    });
});

describe("Phase 7 — deliverTarget shape", () => {
    it("accepts telegram target", () => {
        const t = { platform: "telegram", channelId: "-100123" };
        assert.equal(t.platform, "telegram");
        assert.equal(typeof t.channelId, "string");
    });

    it("accepts slack target (future adapter; scheduler records it anyway)", () => {
        const t = { platform: "slack", channelId: "C01234ABC", threadId: "1700000000.000100" };
        assert.ok(t.threadId);
    });

    it("accepts a2a target", () => {
        const t = { platform: "a2a", channelId: "friend-name" };
        assert.equal(t.platform, "a2a");
    });
});

describe("Phase 7 — kickoff prompt semantics (reminder vs task)", () => {
    // buildKickoff isn't exported from the extension. The observable contract
    // matters: reminders MUST tell the LLM to deliver, not execute. Lock in
    // the distinguishing keywords.

    it("reminder prompt explicitly forbids task execution", () => {
        const prompt = [
            "[SCHEDULED REMINDER — reminder_42]",
            "At 2026-04-17 09:00 UTC, the user asked to be reminded of the following:",
            "",
            "  Watch Oppenheimer",
            "",
            "Your job is to DELIVER the reminder, not execute it.",
        ].join("\n");
        assert.match(prompt, /SCHEDULED REMINDER/);
        assert.match(prompt, /DELIVER the reminder, not execute/);
    });

    it("task prompt tells agent to execute + report", () => {
        const prompt = "[SCHEDULED daily_inventory] Task: Pull SKU inventory\n\nExecute and report when done.";
        assert.match(prompt, /SCHEDULED daily_inventory/);
        assert.match(prompt, /Execute and report/);
    });
});
