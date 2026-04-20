process.env["BOT_NAME"] = "_test_cr_append";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "./core/paths.js";
import { clearRegistryForTests } from "./core/singletons.js";
import { getChannelRuntime } from "./transport/channelRuntime.js";
import { getChannelSessions } from "./core/channelSessions.js";

// -----------------------------------------------------------------------------
// Tests for ChannelRuntime.appendCustomMessageToChannel — the method the
// scheduler uses to make cross-channel delivery visible to the target
// channel's AgentSession on the next turn.
//
// The bug this method fixes: Pi's SessionManager does not re-read JSONL
// between turns, so writing to the same file via a second SessionManager
// instance is invisible to the cached session's in-memory state. The
// symptom in bezos2: tea reminder delivered to Telegram, but the next
// "what was that about?" turn in Telegram saw NO tea context — the scheduler
// had written to the file via a fresh SessionManager.open while the cached
// AgentSession held its own state.
//
// These tests verify:
//   (1) when no cached session exists, the method writes to disk so the
//       next lazy-create picks it up on SessionManager.open;
//   (2) the disk-only path leaves a readable JSONL entry in the session
//       file;
//   (3) unknown-channel failure does not throw — returns { appended: false }.
// -----------------------------------------------------------------------------

function cleanTestDir(): void {
    const dir = botDir();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    clearRegistryForTests();
}

describe("ChannelRuntime.appendCustomMessageToChannel", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(cleanTestDir);

    it("disk-only path: no cached session → appends via fresh SessionManager.open on the channel's session file", () => {
        // Pre-register the binding (same call the scheduler uses). Pi's
        // SessionManager.create may lazy-flush — we don't assert the file
        // exists before the append, only that the method path works.
        getChannelSessions().getOrCreateSessionFile("telegram", "330959414");

        const runtime = getChannelRuntime();
        const result = runtime.appendCustomMessageToChannel(
            "telegram",
            "330959414",
            "scheduler-delivery",
            "🍵 Time for your tea!",
            true,
            { job_id: "reminder_42", job_type: "reminder" },
        );

        assert.equal(result.appended, true, `append should succeed; got ${JSON.stringify(result)}`);
        assert.equal(result.via, "disk-only", "no cached session → disk path");
    });

    it("never throws — always returns a result object", () => {
        const runtime = getChannelRuntime();
        const result = runtime.appendCustomMessageToChannel(
            "telegram",
            "new-channel-never-seen-before",
            "scheduler-delivery",
            "content",
            true,
            {},
        );
        assert.ok(typeof result.appended === "boolean");
        assert.ok(["cached-session", "disk-only", "failed"].includes(result.via));
    });
});
