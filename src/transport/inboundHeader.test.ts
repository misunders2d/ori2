import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { formatInboundHeader, formatInboundPrompt, stripInboundHeader } from "./inboundHeader.js";
import type { Message } from "./types.js";

const base: Message = {
    platform: "telegram",
    channelId: "-100abc",
    senderId: "12345",
    senderDisplayName: "Alice",
    timestamp: Date.parse("2026-04-19T09:00:00Z"),
    text: "",
    addressedToBot: true,
};

describe("inboundHeader round-trip", () => {
    it("format → strip returns the original body (no attachments)", () => {
        const msg: Message = { ...base, text: "hello bot" };
        const prompt = formatInboundPrompt(msg, "Approve ACT-ABC123");
        assert.equal(stripInboundHeader(prompt), "Approve ACT-ABC123");
    });

    it("format → strip on an /init command", () => {
        const prompt = formatInboundPrompt(base, "/init S3cr3tPasscode");
        assert.equal(stripInboundHeader(prompt), "/init S3cr3tPasscode");
    });

    it("body can be multiline — strip preserves everything after the header", () => {
        const body = "line one\nline two\n\n[Attachments]\n--- file.pdf ---\ntext";
        const prompt = formatInboundPrompt(base, body);
        assert.equal(stripInboundHeader(prompt), body);
    });

    it("idempotent: strip on text that has no header returns it unchanged", () => {
        assert.equal(stripInboundHeader("Approve ACT-XYZ999"), "Approve ACT-XYZ999");
        assert.equal(stripInboundHeader(""), "");
        assert.equal(stripInboundHeader("just a message"), "just a message");
    });

    it("header contains the fields the admin_gate + memory extensions read", () => {
        const h = formatInboundHeader(base);
        assert.match(h, /^\[Inbound \|/);
        assert.match(h, /platform: telegram/);
        assert.match(h, /from: Alice/);
        assert.match(h, /sender_id: 12345/);
        assert.match(h, /channel: -100abc/);
        assert.match(h, /time: 2026-04-19T09:00:00\.000Z/);
    });

    it("thread id included only when present", () => {
        const m1: Message = { ...base };
        const m2: Message = { ...base, threadId: "topic-42" };
        assert.doesNotMatch(formatInboundHeader(m1), /thread:/);
        assert.match(formatInboundHeader(m2), /thread: topic-42/);
    });

    it("format is the exact shape admin_gate's approval flow expects", () => {
        // This is the regression test for the f69bb81 refactor bug:
        // channelRuntime used to emit `[telegram inbound | ...]\n<body>`,
        // admin_gate stripped only `[Inbound | ...]\n\n<body>`, so
        // Approve ACT-ABC123 typed from chat never matched. If this test
        // fails, channelRuntime and admin_gate have drifted again — fix
        // the writer, not the test.
        const prompt = formatInboundPrompt(base, "Approve ACT-ABC123");
        assert.match(prompt, /^\[Inbound \|.*\]\n\nApprove ACT-ABC123$/);
    });
});
