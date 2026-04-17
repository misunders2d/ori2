import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { isAddressedToBot, type TelegramMessage, type TelegramUser } from "./telegram.js";

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
