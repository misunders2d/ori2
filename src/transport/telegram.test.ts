import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import {
    isAddressedToBot,
    TelegramAdapter,
    __setTelegramFetchForTests,
    type TelegramMessage,
    type TelegramUser,
} from "./telegram.js";
import { clearRegistryForTests } from "../core/singletons.js";
import type { Message, MessageHandler } from "./types.js";

const bot: TelegramUser = {
    id: 987654,
    is_bot: true,
    first_name: "OriBot",
    username: "MyOriBot",
};

function baseMsg(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
    return {
        message_id: 1,
        from: { id: 111, is_bot: false, first_name: "Alice" },
        chat: { id: -100, type: "supergroup", title: "Team" },
        date: 1_700_000_000,
        ...overrides,
    };
}

describe("Telegram isAddressedToBot", () => {
    it("is always true for private DMs", () => {
        const m = baseMsg({
            chat: { id: 111, type: "private", first_name: "Alice" },
            text: "hello bot",
        });
        assert.equal(isAddressedToBot(m, m.text ?? "", bot), true);
    });

    it("is true in a group when @-mentioned via entities", () => {
        const text = "@MyOriBot summarize please";
        const m = baseMsg({
            text,
            entities: [{ type: "mention", offset: 0, length: 9 }],
        });
        assert.equal(isAddressedToBot(m, text, bot), true);
    });

    it("is case-insensitive on the @mention", () => {
        const text = "hey @myoribot can you help";
        // "@myoribot" = 9 chars at offset 4.
        const m = baseMsg({
            text,
            entities: [{ type: "mention", offset: 4, length: 9 }],
        });
        assert.equal(isAddressedToBot(m, text, bot), true);
    });

    it("ignores a @mention in the text if NOT flagged as an entity by Telegram", () => {
        // Telegram only sets `entities` for actual @username mentions; a plain
        // "@MyOriBot" in quoted text has no entity span. We should trust the
        // entities array, not substring-match the raw text.
        const text = "I was telling Alice '@MyOriBot is dumb' yesterday";
        const m = baseMsg({ text });
        assert.equal(isAddressedToBot(m, text, bot), false);
    });

    it("is true for text_mention pointing at the bot's user id", () => {
        // text_mention covers users without a public @username (private users,
        // or when the bot is linked by name rather than @).
        const text = "Bot please look";
        const m = baseMsg({
            text,
            entities: [{ type: "text_mention", offset: 0, length: 3, user: bot }],
        });
        assert.equal(isAddressedToBot(m, text, bot), true);
    });

    it("is false when a text_mention points at some OTHER user", () => {
        const text = "Alice please look";
        const m = baseMsg({
            text,
            entities: [{
                type: "text_mention",
                offset: 0,
                length: 5,
                user: { id: 222, is_bot: false, first_name: "Alice" },
            }],
        });
        assert.equal(isAddressedToBot(m, text, bot), false);
    });

    it("is true when replying to one of the bot's messages", () => {
        const m = baseMsg({
            text: "yes do that",
            reply_to_message: {
                message_id: 42,
                from: bot,
                chat: { id: -100, type: "supergroup" },
                date: 1_699_999_000,
                text: "Shall I proceed?",
            },
        });
        assert.equal(isAddressedToBot(m, m.text ?? "", bot), true);
    });

    it("is false in a group when another user is @-mentioned", () => {
        const text = "@Alice what did you mean?";
        const m = baseMsg({
            text,
            entities: [{ type: "mention", offset: 0, length: 6 }],
        });
        assert.equal(isAddressedToBot(m, text, bot), false);
    });

    it("is false in a group when no mention and no reply", () => {
        const text = "I just watched The Matrix";
        const m = baseMsg({ text });
        assert.equal(isAddressedToBot(m, text, bot), false);
    });

    it("works on caption_entities (media with caption)", () => {
        const caption = "look @MyOriBot";
        const m = baseMsg({
            caption,
            caption_entities: [{ type: "mention", offset: 5, length: 9 }],
        });
        assert.equal(isAddressedToBot(m, caption, bot), true);
    });

    it("returns false when botInfo is unknown (adapter not yet initialised)", () => {
        const text = "@MyOriBot hi";
        const m = baseMsg({
            text,
            entities: [{ type: "mention", offset: 0, length: 9 }],
        });
        assert.equal(isAddressedToBot(m, text, undefined), false);
    });
});

// =============================================================================
// Tests for the adapter's attachment pipeline.
//
// Injects a mock fetch that responds to Telegram's getFile + file-download
// endpoints, runs handleIncoming, and asserts the Message delivered to the
// dispatcher carries a correctly-typed MediaPayload for each inbound kind.
//
// Covers: photo, document-as-image, document-as-pptx (binary), audio, voice,
// video. This is the step BEFORE channelRuntime's buildPromptFromMessage —
// if the adapter drops the attachment here, nothing downstream can save it.
// =============================================================================

const TINY_IMAGE_BYTES = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX///+nxBvIAAAACklEQVQI12NgAAAAAgABc3UBGAAAAABJRU5ErkJggg==",
    "base64",
);
const TINY_PPTX_BYTES = Buffer.from("PK\x03\x04_fake_pptx_contents_"); // ZIP magic + garbage

/** Fetch stub that answers getFile and file/bot/... download requests. */
function makeFetchStub(filesById: Record<string, Buffer>): typeof fetch {
    return (async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input.toString();
        // getFile: POST https://api.telegram.org/botTOKEN/getFile  body={file_id: "..."}
        if (url.endsWith("/getFile")) {
            const body = _init?.body ? JSON.parse(String(_init.body)) : {};
            const fileId = body.file_id as string;
            if (!filesById[fileId]) {
                return new Response(JSON.stringify({ ok: false, description: "file not found" }), {
                    status: 404,
                    headers: { "content-type": "application/json" },
                });
            }
            return new Response(JSON.stringify({ ok: true, result: { file_path: `stub/${fileId}.bin` } }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }
        // download: GET https://api.telegram.org/file/botTOKEN/stub/<fileId>.bin
        const dlMatch = url.match(/\/file\/bot[^/]+\/stub\/([^.]+)\.bin$/);
        if (dlMatch) {
            const fileId = dlMatch[1]!;
            const buf = filesById[fileId];
            if (!buf) return new Response("", { status: 404 });
            // Response.body accepts a Uint8Array; Node's Buffer extends it.
            return new Response(new Uint8Array(buf), { status: 200 });
        }
        // getMe or anything else — minimal OK stub.
        return new Response(JSON.stringify({ ok: true, result: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }) as typeof fetch;
}

describe("TelegramAdapter attachment pipeline", () => {
    let adapter: TelegramAdapter;
    let delivered: Message[];

    beforeEach(() => {
        clearRegistryForTests();
        delivered = [];
        adapter = new TelegramAdapter();
        const handler: MessageHandler = async (msg) => { delivered.push(msg); };
        adapter.setHandler(handler);
    });

    afterEach(() => {
        __setTelegramFetchForTests(null);
        clearRegistryForTests();
    });

    const dmMsg = (overrides: Partial<TelegramMessage>): TelegramMessage => ({
        message_id: 1,
        from: { id: 111, is_bot: false, first_name: "Alice" },
        chat: { id: 111, type: "private", first_name: "Alice" },
        date: 1_700_000_000,
        ...overrides,
    });

    it("photo: adapter produces a MediaPayload.image with base64 data", async () => {
        __setTelegramFetchForTests(makeFetchStub({ file_photo_1: TINY_IMAGE_BYTES }));
        const m = dmMsg({
            caption: "what do you see?",
            photo: [
                { file_id: "file_photo_1", file_unique_id: "u1", file_size: TINY_IMAGE_BYTES.length, width: 1, height: 1 },
            ],
        });

        await adapter.__handleIncomingForTests("TESTTOKEN", m);

        assert.equal(delivered.length, 1);
        const msg = delivered[0]!;
        assert.equal(msg.text, "what do you see?");
        assert.equal(msg.addressedToBot, true);
        assert.ok(msg.attachments);
        assert.equal(msg.attachments!.length, 1);
        const att = msg.attachments![0]!;
        assert.equal(att.kind, "image", "photo MUST become MediaPayload.image, not binary");
        if (att.kind === "image") {
            assert.equal(att.mimeType, "image/jpeg");
            assert.equal(att.data, TINY_IMAGE_BYTES.toString("base64"));
        }
    });

    it("document with image/jpeg mime: adapter produces a MediaPayload.image (same as photo)", async () => {
        __setTelegramFetchForTests(makeFetchStub({ file_doc_jpeg: TINY_IMAGE_BYTES }));
        const m = dmMsg({
            caption: "look",
            document: {
                file_id: "file_doc_jpeg",
                file_unique_id: "u2",
                file_name: "PXL_20260419.jpg",
                mime_type: "image/jpeg",
                file_size: TINY_IMAGE_BYTES.length,
            },
        });

        await adapter.__handleIncomingForTests("TESTTOKEN", m);

        assert.equal(delivered.length, 1);
        const att = delivered[0]!.attachments![0]!;
        assert.equal(att.kind, "image", "document with image/jpeg mime MUST route to image, NOT binary");
        if (att.kind === "image") {
            assert.equal(att.filename, "PXL_20260419.jpg");
        }
    });

    it("document with application/vnd.ms-pptx (pptx): adapter produces a MediaPayload.binary", async () => {
        __setTelegramFetchForTests(makeFetchStub({ file_pptx: TINY_PPTX_BYTES }));
        const m = dmMsg({
            caption: "fix these slides",
            document: {
                file_id: "file_pptx",
                file_unique_id: "u3",
                file_name: "slides.pptx",
                mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                file_size: TINY_PPTX_BYTES.length,
            },
        });

        await adapter.__handleIncomingForTests("TESTTOKEN", m);

        const att = delivered[0]!.attachments![0]!;
        assert.equal(att.kind, "binary");
        if (att.kind === "binary") {
            assert.equal(att.filename, "slides.pptx");
            assert.ok(att.localPath.length > 0);
        }
    });

    it("document with missing mime_type: falls back to octet-stream → binary", async () => {
        __setTelegramFetchForTests(makeFetchStub({ file_nomime: TINY_PPTX_BYTES }));
        const m = dmMsg({
            document: {
                file_id: "file_nomime",
                file_unique_id: "u4",
                file_name: "mystery.bin",
                file_size: TINY_PPTX_BYTES.length,
                // mime_type intentionally omitted — some clients don't set it
            },
        });

        await adapter.__handleIncomingForTests("TESTTOKEN", m);

        const att = delivered[0]!.attachments![0]!;
        assert.equal(att.kind, "binary");
    });

    it("audio document: adapter produces a MediaPayload.binary (audio/*)", async () => {
        __setTelegramFetchForTests(makeFetchStub({ file_audio: Buffer.from("ID3_fake_mp3_") }));
        const m = dmMsg({
            audio: {
                file_id: "file_audio",
                file_unique_id: "u5",
                file_name: "note.mp3",
                mime_type: "audio/mpeg",
                file_size: 16,
                duration: 3,
            },
        });

        await adapter.__handleIncomingForTests("TESTTOKEN", m);

        const att = delivered[0]!.attachments![0]!;
        assert.equal(att.kind, "binary");
        assert.equal(att.mimeType, "audio/mpeg");
    });

    it("voice note: adapter produces a MediaPayload.binary (audio/ogg)", async () => {
        __setTelegramFetchForTests(makeFetchStub({ file_voice: Buffer.from("OggS_fake_") }));
        const m = dmMsg({
            voice: {
                file_id: "file_voice",
                file_unique_id: "u6",
                mime_type: "audio/ogg",
                file_size: 10,
                duration: 2,
            },
        });

        await adapter.__handleIncomingForTests("TESTTOKEN", m);

        const att = delivered[0]!.attachments![0]!;
        assert.equal(att.kind, "binary");
        assert.equal(att.mimeType, "audio/ogg");
    });

    it("video document: adapter produces a MediaPayload.binary (video/*)", async () => {
        __setTelegramFetchForTests(makeFetchStub({ file_video: Buffer.from("\x00\x00\x00\x18ftypmp42_fake") }));
        const m = dmMsg({
            video: {
                file_id: "file_video",
                file_unique_id: "u7",
                file_name: "clip.mp4",
                mime_type: "video/mp4",
                file_size: 20,
                duration: 3,
                width: 640,
                height: 480,
            },
        });

        await adapter.__handleIncomingForTests("TESTTOKEN", m);

        const att = delivered[0]!.attachments![0]!;
        assert.equal(att.kind, "binary");
        assert.equal(att.mimeType, "video/mp4");
    });

    it("photo + caption: text and attachment BOTH arrive on the same Message", async () => {
        __setTelegramFetchForTests(makeFetchStub({ photo_with_caption: TINY_IMAGE_BYTES }));
        const m = dmMsg({
            caption: "is this cheese or plastic",
            photo: [{ file_id: "photo_with_caption", file_unique_id: "u8", file_size: TINY_IMAGE_BYTES.length, width: 1, height: 1 }],
        });

        await adapter.__handleIncomingForTests("TESTTOKEN", m);

        const msg = delivered[0]!;
        assert.equal(msg.text, "is this cheese or plastic");
        assert.equal(msg.attachments![0]!.kind, "image");
    });
});
