process.env["BOT_NAME"] = "_test_telegram";

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { isAddressedToBot, TelegramAdapter, type TelegramMessage, type TelegramUser } from "./telegram.js";
import type { Message, MediaPayload } from "./types.js";

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
// Media-group (Telegram album) buffering. When a user sends N photos/videos
// at once, Telegram delivers N separate updates all sharing a media_group_id.
// The adapter MUST buffer (1200ms debounce per pi-telegram reference) and
// dispatch a single logical Message with merged attachments[]. Without the
// buffer, each album item would trigger its own agent turn — N replies to
// ONE user intent.
// =============================================================================

describe("TelegramAdapter — media-group buffering", () => {
    // Subclass that stubs the private network calls so tests don't hit Telegram.
    // Keeps the buffering contract (media_group_id debounce + merge) as the
    // sole behavior under test.
    class TestTelegramAdapter extends TelegramAdapter {
        public captured: Message[] = [];
        constructor() {
            super();
            this.setHandler(async (msg) => { this.captured.push(msg); });
        }
        // Short-circuit file downloads — adapter shouldn't hit the network in unit tests.
        protected async collectStub(_token: string, m: TelegramMessage): Promise<MediaPayload[]> {
            // One fake image per message if it has a photo field.
            if (m.photo && m.photo.length > 0) {
                return [{ kind: "image", mimeType: "image/jpeg", data: `B64-${m.message_id}`, filename: `photo-${m.message_id}.jpg` }];
            }
            return [];
        }
    }

    // Replace the private collectAttachments with our stub. Avoids fake-API-key boilerplate.
    function rigAdapter(): TestTelegramAdapter {
        const a = new TestTelegramAdapter();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (a as any).collectAttachments = (a as any).collectStub.bind(a);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (a as any).botInfo = bot;
        return a;
    }

    // Bypass the getUpdates loop by calling handleIncoming directly.
    async function feed(a: TestTelegramAdapter, m: TelegramMessage): Promise<void> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (a as any).handleIncoming("dummy-token", m);
    }

    function photoMsg(message_id: number, caption: string | undefined, media_group_id: string | undefined): TelegramMessage {
        const m: TelegramMessage = {
            message_id,
            from: { id: 111, is_bot: false, first_name: "Alice" },
            chat: { id: -100, type: "supergroup", title: "Team" },
            date: 1_700_000_000,
            photo: [{ file_id: `f${message_id}`, file_unique_id: `u${message_id}`, width: 640, height: 480 }],
        };
        if (caption !== undefined) m.caption = caption;
        if (media_group_id !== undefined) m.media_group_id = media_group_id;
        return m;
    }

    it("single message (no media_group_id) dispatches immediately", async () => {
        const a = rigAdapter();
        await feed(a, photoMsg(1, "solo photo", undefined));
        assert.equal(a.captured.length, 1);
        assert.equal(a.captured[0]!.attachments?.length, 1);
        assert.equal(a.captured[0]!.text, "solo photo");
    });

    it("two messages sharing a media_group_id → buffered, ONE dispatch after debounce with merged attachments", async () => {
        const a = rigAdapter();
        await feed(a, photoMsg(1, "album caption", "album-xyz"));
        await feed(a, photoMsg(2, undefined,       "album-xyz"));

        // Nothing dispatched yet — still buffering.
        assert.equal(a.captured.length, 0, "must wait for debounce to flush");

        // Wait past the debounce (1200ms) + small slack.
        await new Promise((r) => setTimeout(r, 1350));

        assert.equal(a.captured.length, 1, "flushed exactly one merged message");
        const m = a.captured[0]!;
        assert.equal(m.attachments?.length, 2, "both album items' attachments merged");
        assert.match(m.text, /album caption/);
    });

    it("different media_group_ids don't collide — each gets its own buffer + flush", async () => {
        const a = rigAdapter();
        await feed(a, photoMsg(1, "A", "group-A"));
        await feed(a, photoMsg(2, "B", "group-B"));
        await new Promise((r) => setTimeout(r, 1350));
        assert.equal(a.captured.length, 2, "two separate flushes");
    });

    it("a.stop() clears in-flight buffer timers — buffered album is silently dropped", async () => {
        const a = rigAdapter();
        await feed(a, photoMsg(1, "pending album", "group-dropped"));
        // Stop before debounce fires.
        await a.stop();
        await new Promise((r) => setTimeout(r, 1350));
        assert.equal(a.captured.length, 0, "stop() must cancel pending flush — no dispatch after adapter is torn down");
    });
});
