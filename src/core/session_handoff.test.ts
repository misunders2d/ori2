process.env["BOT_NAME"] = "_test_session_handoff";

import { describe, it, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "./paths.js";
import {
    writePendingHandoff,
    readPendingHandoff,
} from "./handoffPending.js";
import sessionHandoffFactory from "../../.pi/extensions/session_handoff.js";

interface FakePi {
    handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
    api: {
        on: (event: string, handler: (...args: unknown[]) => unknown) => void;
    };
}

function makeFakePi(): FakePi {
    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    return {
        handlers,
        api: {
            on: (event, handler) => {
                const list = handlers.get(event) ?? [];
                list.push(handler);
                handlers.set(event, list);
            },
        },
    };
}

function ctxWithOrigin(origin: { platform: string; channelId: string; senderId: string } | null) {
    const branch = origin
        ? [{
            type: "custom",
            customType: "transport-origin",
            data: {
                platform: origin.platform,
                channelId: origin.channelId,
                senderId: origin.senderId,
                senderDisplayName: origin.senderId,
                timestamp: Date.now(),
            },
        }]
        : [];
    return { sessionManager: { getBranch: () => branch }, ui: { notify: () => {} } };
}

function cleanTestDir(): void {
    const dir = botDir();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe("session_handoff extension — before_agent_start consumer", () => {
    after(cleanTestDir);
    beforeEach(cleanTestDir);

    it("no origin → returns undefined (no injection)", async () => {
        const fake = makeFakePi();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sessionHandoffFactory(fake.api as any);
        const handler = fake.handlers.get("before_agent_start")?.[0];
        assert.ok(handler, "extension must register a before_agent_start handler");
        const result = await handler({ prompt: "hi", systemPrompt: "" }, ctxWithOrigin(null));
        assert.equal(result, undefined, "no origin must result in no injection");
    });

    it("origin + no pending → returns undefined", async () => {
        const fake = makeFakePi();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sessionHandoffFactory(fake.api as any);
        const handler = fake.handlers.get("before_agent_start")![0]!;
        const result = await handler(
            { prompt: "hi", systemPrompt: "" },
            ctxWithOrigin({ platform: "telegram", channelId: "-100a", senderId: "alice" }),
        );
        assert.equal(result, undefined, "no pending handoff → no injection");
    });

    it("origin + pending → returns {message} with the summary AND clears the pending file", async () => {
        writePendingHandoff("telegram", "-100consume", "Prior talk covered weather + Vienna.", "/tmp/old.jsonl");
        assert.ok(readPendingHandoff("telegram", "-100consume"), "precondition: pending exists");

        const fake = makeFakePi();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sessionHandoffFactory(fake.api as any);
        const handler = fake.handlers.get("before_agent_start")![0]!;
        const result = await handler(
            { prompt: "hello again", systemPrompt: "" },
            ctxWithOrigin({ platform: "telegram", channelId: "-100consume", senderId: "alice" }),
        ) as { message?: { customType?: string; content?: Array<{ type: string; text: string }>; display?: boolean } } | undefined;

        assert.ok(result, "must return a result object");
        assert.ok(result!.message, "must return a message");
        assert.equal(result!.message!.customType, "session-handoff-summary");
        assert.equal(result!.message!.display, true, "display=true so the agent sees it as context");
        assert.match(result!.message!.content![0]!.text, /Prior talk covered weather/);

        // Pending file MUST be cleared — re-injecting on every turn would spam the context.
        assert.equal(
            readPendingHandoff("telegram", "-100consume"),
            null,
            "pending file must be cleared after consumption",
        );
    });

    it("second invocation after consumption → no injection (pending stays cleared)", async () => {
        writePendingHandoff("telegram", "-100once", "only-once summary", undefined);
        const fake = makeFakePi();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sessionHandoffFactory(fake.api as any);
        const handler = fake.handlers.get("before_agent_start")![0]!;

        // First call consumes it.
        const first = await handler(
            { prompt: "x", systemPrompt: "" },
            ctxWithOrigin({ platform: "telegram", channelId: "-100once", senderId: "a" }),
        );
        assert.ok(first, "first call must inject");

        // Second call — no more pending.
        const second = await handler(
            { prompt: "y", systemPrompt: "" },
            ctxWithOrigin({ platform: "telegram", channelId: "-100once", senderId: "a" }),
        );
        assert.equal(second, undefined, "second call must not re-inject");
    });
});
