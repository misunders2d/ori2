process.env["BOT_NAME"] = "_test_channel_runtime";

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import type { Model } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

import { buildPromptFromMessage, ChannelRuntime, getChannelRuntime, type ChannelEntry } from "./channelRuntime.js";
import { clearRegistryForTests } from "../core/singletons.js";
import type { MediaPayload, Message } from "./types.js";

// =============================================================================
// Tests for the attachment → LLM-prompt pipeline inside channelRuntime.
//
// The user reported "bot doesn't see my images" from Telegram. Instead of
// staring at code + guessing, these tests drive the actual flow:
//   (a) buildPromptFromMessage — pure function: Message → { text, images }.
//       Proves image/text/binary attachments land in the right slots AND
//       that vision vs text-only models affect routing.
//   (b) handleActiveInbound — with a stub AgentSession. Proves the images
//       array from (a) is actually passed to session.prompt() instead of
//       being dropped on the floor somewhere between kickoff and Pi.
// =============================================================================

function visionModel(): Model<any> {
    return {
        id: "stub-vision",
        name: "Stub Vision Model",
        provider: "stub" as never,
        api: "anthropic-messages" as never,
        baseUrl: "https://stub.example",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8192,
    };
}

function textOnlyModel(): Model<any> {
    return { ...visionModel(), id: "stub-text-only", input: ["text"] };
}

function makeMsg(text: string, attachments?: MediaPayload[]): Message {
    const m: Message = {
        platform: "telegram",
        channelId: "-100_test",
        senderId: "user_1",
        senderDisplayName: "Alice",
        timestamp: 1_700_000_000_000,
        text,
        addressedToBot: true,
    };
    if (attachments && attachments.length > 0) m.attachments = attachments;
    return m;
}

const imagePayload = (filename = "cheese.jpg"): MediaPayload => ({
    kind: "image",
    mimeType: "image/jpeg",
    data: "AAAA_base64_bytes",
    filename,
});

const textPayload = (text: string, filename = "notes.pdf"): MediaPayload => ({
    kind: "text",
    mimeType: "application/pdf",
    text,
    filename,
    sourceBytes: text.length,
});

const binaryPayload = (filename = "slides.pptx"): MediaPayload => ({
    kind: "binary",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    localPath: "/tmp/_test_" + filename,
    sizeBytes: 14_567,
    filename,
});

describe("buildPromptFromMessage", () => {
    it("no attachments: kickoff-only text, no images", () => {
        const msg = makeMsg("hello bot");
        const { text, images } = buildPromptFromMessage(msg, visionModel());
        assert.match(text, /hello bot/);
        assert.match(text, /^\[Inbound \| platform: telegram/);
        assert.equal(images.length, 0);
        // Must NOT mention attachments when there are none.
        assert.doesNotMatch(text, /\[Attachments\]/);
    });

    it("image + vision-capable model: image forwarded as ImageContent, reference in text", () => {
        const msg = makeMsg("what do you see?", [imagePayload()]);
        const { text, images } = buildPromptFromMessage(msg, visionModel());
        assert.equal(images.length, 1);
        assert.equal(images[0]!.type, "image");
        assert.equal(images[0]!.mimeType, "image/jpeg");
        assert.equal(images[0]!.data, "AAAA_base64_bytes");
        assert.match(text, /\[Attachments\]/);
        assert.match(text, /\[Image: cheese\.jpg — sent to the vision model\]/);
    });

    it("image + text-only model: image NOT forwarded, text references it with hint to switch model", () => {
        const msg = makeMsg("what do you see?", [imagePayload()]);
        const { text, images } = buildPromptFromMessage(msg, textOnlyModel());
        assert.equal(images.length, 0, "text-only model must NOT receive an images payload");
        assert.match(text, /\[Image attachment: cheese\.jpg — current model has no vision/);
    });

    it("image + undefined model (no session model yet): treated as text-only — no images forwarded", () => {
        const msg = makeMsg("what do you see?", [imagePayload()]);
        const { text, images } = buildPromptFromMessage(msg, undefined);
        assert.equal(images.length, 0);
        assert.match(text, /\[Image attachment:/);
    });

    it("text (document) attachment: inlined into prompt text, no images", () => {
        const msg = makeMsg("summarise please", [textPayload("Q1 revenue up 12%", "q1.pdf")]);
        const { text, images } = buildPromptFromMessage(msg, visionModel());
        assert.equal(images.length, 0);
        assert.match(text, /--- q1\.pdf/);
        assert.match(text, /Q1 revenue up 12%/);
    });

    it("binary (pptx/xlsx/zip) attachment: path-referenced in text, no images", () => {
        const msg = makeMsg("fix up these slides", [binaryPayload("slides.pptx")]);
        const { text, images } = buildPromptFromMessage(msg, visionModel());
        assert.equal(images.length, 0);
        assert.match(text, /\[Binary attachment: slides\.pptx .* at \/tmp\/_test_slides\.pptx\]/);
    });

    it("mixed (image + pdf-text + binary) on vision model: correct distribution", () => {
        const msg = makeMsg("here you go", [
            imagePayload("chart.jpg"),
            textPayload("Executive summary: ...", "report.pdf"),
            binaryPayload("raw_data.xlsx"),
        ]);
        const { text, images } = buildPromptFromMessage(msg, visionModel());
        assert.equal(images.length, 1);
        assert.equal(images[0]!.mimeType, "image/jpeg");
        assert.match(text, /\[Image: chart\.jpg/);
        assert.match(text, /--- report\.pdf/);
        assert.match(text, /Executive summary/);
        assert.match(text, /\[Binary attachment: raw_data\.xlsx/);
    });

    it("multiple images on vision model: all forwarded", () => {
        const msg = makeMsg("compare", [
            imagePayload("before.jpg"),
            imagePayload("after.jpg"),
        ]);
        const { images } = buildPromptFromMessage(msg, visionModel());
        assert.equal(images.length, 2);
    });
});

// -----------------------------------------------------------------------------
// handleActiveInbound integration: a stub AgentSession captures what we
// actually call on it. This is the test that would have caught my last
// guessing attempt — if session.prompt doesn't receive `images`, images
// cannot reach the LLM, period.
// -----------------------------------------------------------------------------

interface StubSession {
    model: Model<any>;
    isStreaming: boolean;
    promptCalls: Array<{ text: string; options: Record<string, unknown> }>;
    sessionManager: { appendCustomEntry: (type: string, data?: unknown) => string };
}

function makeStubSession(model: Model<any>): StubSession & AgentSession {
    const s: StubSession = {
        model,
        isStreaming: false,
        promptCalls: [],
        sessionManager: { appendCustomEntry: () => "entry-id" },
    };
    const agentSession = {
        ...s,
        // fill in just enough surface that handleActiveInbound won't crash.
        // setModel and setThinkingLevel are no-ops because no binding is set
        // in the tests below (applyChannelModelBinding short-circuits when
        // there's no binding + no defaultModel).
        setModel: async () => {},
        setThinkingLevel: () => {},
        prompt: async (text: string, options: Record<string, unknown>) => {
            s.promptCalls.push({ text, options });
        },
        abort: async () => {},
    };
    return agentSession as unknown as StubSession & AgentSession;
}

function makeEntry(session: StubSession & AgentSession): ChannelEntry {
    return {
        session,
        sessionFile: "/tmp/_test_session.jsonl",
        lastActivity: Date.now(),
        unsubscribe: () => {},
    };
}

describe("ChannelRuntime.handleActiveInbound: images reach session.prompt()", () => {
    let runtime: ChannelRuntime;

    beforeEach(() => {
        clearRegistryForTests();
        runtime = getChannelRuntime();
    });

    afterEach(async () => {
        await runtime.stop().catch(() => {});
        clearRegistryForTests();
    });

    it("image attachment + vision model → session.prompt receives it in options.images", async () => {
        const session = makeStubSession(visionModel());
        const entry = makeEntry(session);
        runtime.__injectChannelEntryForTests("telegram", "-100_test", entry);

        const msg = makeMsg("what do you see?", [imagePayload("cheese.jpg")]);
        await runtime.handleActiveInbound(msg);

        assert.equal(session.promptCalls.length, 1, "session.prompt must be called exactly once");
        const call = session.promptCalls[0]!;
        const opts = call.options as { images?: unknown[]; streamingBehavior?: string };
        assert.ok(opts.images, "prompt options MUST include an images array when an image attachment arrived");
        assert.equal((opts.images as unknown[]).length, 1);
        const img = (opts.images as Array<{ type: string; mimeType: string; data: string }>)[0]!;
        assert.equal(img.type, "image");
        assert.equal(img.mimeType, "image/jpeg");
        assert.equal(img.data, "AAAA_base64_bytes");
        // Also verify the text body carries the [Image: ...] reference for
        // the LLM to understand context.
        assert.match(call.text, /\[Image: cheese\.jpg — sent to the vision model\]/);
    });

    it("image attachment + text-only model → session.prompt WITHOUT images, but text references image", async () => {
        const session = makeStubSession(textOnlyModel());
        const entry = makeEntry(session);
        runtime.__injectChannelEntryForTests("telegram", "-100_test", entry);

        const msg = makeMsg("what is this?", [imagePayload("cheese.jpg")]);
        await runtime.handleActiveInbound(msg);

        assert.equal(session.promptCalls.length, 1);
        const opts = session.promptCalls[0]!.options as { images?: unknown[] };
        // Critical: text-only models must NOT be given an images payload
        // because some provider APIs reject the whole request rather than
        // ignoring unsupported content. Without this check the entire turn
        // would fail and the user would see "⚠ The model call failed".
        assert.equal(opts.images, undefined);
        assert.match(session.promptCalls[0]!.text, /current model has no vision/);
    });

    it("pptx/binary attachment → session.prompt WITHOUT images, text has a path reference", async () => {
        const session = makeStubSession(visionModel());
        const entry = makeEntry(session);
        runtime.__injectChannelEntryForTests("telegram", "-100_test", entry);

        const msg = makeMsg("open this", [binaryPayload("deck.pptx")]);
        await runtime.handleActiveInbound(msg);

        const opts = session.promptCalls[0]!.options as { images?: unknown[] };
        assert.equal(opts.images, undefined);
        assert.match(session.promptCalls[0]!.text, /\[Binary attachment: deck\.pptx/);
    });

    it("no attachments → session.prompt with no images option", async () => {
        const session = makeStubSession(visionModel());
        const entry = makeEntry(session);
        runtime.__injectChannelEntryForTests("telegram", "-100_test", entry);

        await runtime.handleActiveInbound(makeMsg("just text, no files"));

        const opts = session.promptCalls[0]!.options as { images?: unknown[] };
        assert.equal(opts.images, undefined);
    });

    it("threadId on inbound is remembered for later reply-routing", async () => {
        const session = makeStubSession(visionModel());
        const entry = makeEntry(session);
        runtime.__injectChannelEntryForTests("telegram", "-100_test", entry);

        const msg: Message = { ...makeMsg("hi"), threadId: "topic-42" };
        await runtime.handleActiveInbound(msg);

        assert.equal(entry.lastThreadId, "topic-42");
    });
});
