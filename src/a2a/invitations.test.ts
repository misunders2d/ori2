import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
    encodeInvitationToken,
    decodeInvitationToken,
    isInvitationExpired,
    INVITATION_TTL_MS,
} from "./invitations.js";
import type { InvitationTokenPayload } from "./types.js";

const SAMPLE: InvitationTokenPayload = {
    inviter_name: "AmazonBot",
    inviter_url: "https://amazon-bot.trycloudflare.com",
    inviter_key: "deadbeef".repeat(8),
    invite_id: "00000000-0000-4000-8000-000000000000",
    expires_at: 1_800_000_000_000,
};

describe("invitations.ts", () => {
    it("encode → decode round-trips faithfully", () => {
        const t = encodeInvitationToken(SAMPLE);
        const back = decodeInvitationToken(t);
        assert.deepEqual(back, SAMPLE);
    });

    it("encoded token is base64url (no '+', '/', '=' padding)", () => {
        const t = encodeInvitationToken(SAMPLE);
        assert.equal(/[+/=]/.test(t), false);
    });

    it("decode returns null for non-base64 garbage", () => {
        // Reserved characters that are not valid base64url
        assert.equal(decodeInvitationToken("not a token at all $$$ +++"), null);
    });

    it("decode returns null for valid base64 of malformed JSON", () => {
        const bad = Buffer.from("{not json}", "utf-8").toString("base64url");
        assert.equal(decodeInvitationToken(bad), null);
    });

    it("decode returns null for missing required fields", () => {
        const partial = Buffer.from(JSON.stringify({ inviter_name: "x" }), "utf-8").toString("base64url");
        assert.equal(decodeInvitationToken(partial), null);
    });

    it("isInvitationExpired returns true for past expiry", () => {
        assert.equal(isInvitationExpired({ ...SAMPLE, expires_at: 1 }), true);
    });

    it("isInvitationExpired returns false for future expiry", () => {
        assert.equal(isInvitationExpired({ ...SAMPLE, expires_at: Date.now() + 60_000 }), false);
    });

    it("INVITATION_TTL_MS is 1 hour", () => {
        assert.equal(INVITATION_TTL_MS, 60 * 60 * 1000);
    });
});
