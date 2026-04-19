process.env["BOT_NAME"] = "_test_admin_gate_header";

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { stripMetadataHeader } from "../.pi/extensions/admin_gate.js";

// =============================================================================
// REGRESSION GUARD — admin_gate.stripMetadataHeader must cover BOTH the CLI
// (transport_bridge) envelope AND the non-CLI (channelRuntime) envelope.
//
// CLASS OF BUG: the in-process rewrite (f69bb81) changed the inbound prefix
// format from "[Inbound | ...]" (uppercase I, added by transport_bridge) to
// "[<platform> inbound | ...]" (lowercase, added by channelRuntime). admin_gate
// kept matching only the old format → on Telegram, the stripped text still
// contained the envelope, APPROVE_REGEX's `^` anchor failed, Approve ACT-XXX
// was never detected, LLM saw the approval as a fresh prompt and re-staged,
// loop forever.
//
// If stripMetadataHeader doesn't peel BOTH envelopes, admin approval in chat
// is fundamentally broken. These tests are load-bearing.
// =============================================================================

describe("stripMetadataHeader — envelope peeling (regression guard)", () => {
    it("peels the transport_bridge CLI envelope — '[Inbound | ...]\\n\\n<body>'", () => {
        const out = stripMetadataHeader(
            "[Inbound | from: alice | cli=cli:default]\n\nApprove ACT-ABC123",
        );
        assert.equal(out, "Approve ACT-ABC123");
    });

    it("peels the channelRuntime non-CLI envelope — '[<platform> inbound | ...]\\n<body>'", () => {
        // The channelRuntime.buildKickoffContent format: lowercase "inbound",
        // SINGLE newline. If the regex required \n\n (two newlines) or
        // uppercase "Inbound", this match would fail and the test assertion
        // would read "[telegram inbound ...]\nApprove ..." instead of just
        // "Approve ...".
        const out = stripMetadataHeader(
            "[telegram inbound | from: @alice (123456) | channel: -1001234567890]\nApprove ACT-AVGYS8",
        );
        assert.equal(out, "Approve ACT-AVGYS8");
    });

    it("peels Slack/other-platform envelopes by the same rule", () => {
        const out = stripMetadataHeader(
            "[slack inbound | from: @bob (U123) | channel: C7890]\nApprove ACT-XYZ000",
        );
        assert.equal(out, "Approve ACT-XYZ000");
    });

    it("passes terminal input through unchanged (no envelope present)", () => {
        assert.equal(stripMetadataHeader("Approve ACT-ABC123"), "Approve ACT-ABC123");
        assert.equal(stripMetadataHeader("/init my-passcode"), "/init my-passcode");
    });

    it("tolerates trailing whitespace and multiline bodies", () => {
        const out = stripMetadataHeader(
            "[telegram inbound | from: @c | channel: -1]\n\n\nline1\nline2",
        );
        assert.equal(out, "line1\nline2");
    });

    it("does NOT misinterpret a user message that happens to contain square brackets", () => {
        // If the regex is too greedy it could swallow legitimate user content
        // that looks bracket-y. "[draft]" at the start of a non-envelope
        // message must stay intact.
        const out = stripMetadataHeader("[draft] should I publish?");
        assert.equal(out, "[draft] should I publish?");
    });

    it("END-TO-END: channelRuntime envelope + APPROVE_REGEX matches the stripped body", () => {
        // This is the load-bearing assertion for the bug we just fixed.
        // Feed an envelope of the exact shape channelRuntime emits,
        // stripMetadataHeader → trim → apply APPROVE_REGEX. Must yield
        // the ACT token.
        const raw =
            "[telegram inbound | from: @alice (123) | channel: -100xyz]\nApprove ACT-AVGYS8";
        const body = stripMetadataHeader(raw).trim();
        // Mirrors admin_gate's APPROVE_REGEX literally.
        const APPROVE_REGEX = /^\s*approve\s+(ACT-[A-Z0-9]{6})(?:\s+(\d{6}))?\s*$/i;
        const m = body.match(APPROVE_REGEX);
        assert.ok(m, "APPROVE_REGEX must match the stripped body — if this fails, admin approval in chat is broken");
        assert.equal(m![1], "ACT-AVGYS8");
    });
});
