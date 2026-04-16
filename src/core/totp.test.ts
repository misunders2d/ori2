process.env["BOT_NAME"] = "_test_totp";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { authenticator } from "otplib";
import { botDir } from "./paths.js";
import { getVault } from "./vault.js";
import { enroll, verify, isEnrolled, disable, status } from "./totp.js";

const TEST_DIR = botDir();

function rmTestDir() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

before(rmTestDir);
after(rmTestDir);
beforeEach(() => {
    rmTestDir();
    getVault().reset();
});

describe("TOTP enroll", () => {
    it("returns a secret + an otpauth URI", () => {
        const r = enroll("telegram", "alice", "Alice");
        assert.ok(r.secret.length > 0);
        assert.match(r.otpauthUri, /^otpauth:\/\/totp\//);
        assert.match(r.otpauthUri, /secret=/);
    });

    it("isEnrolled flips from false to true", () => {
        assert.equal(isEnrolled("telegram", "alice"), false);
        enroll("telegram", "alice");
        assert.equal(isEnrolled("telegram", "alice"), true);
    });

    it("re-enrollment generates a new secret", () => {
        const a = enroll("telegram", "alice");
        const b = enroll("telegram", "alice");
        assert.notEqual(a.secret, b.secret);
    });

    it("issuer in the URI includes the bot name", () => {
        const r = enroll("telegram", "alice");
        assert.match(decodeURIComponent(r.otpauthUri), /issuer=ori2:_test_totp/);
    });

    it("display name is included in the account label when distinct from senderId", () => {
        const r = enroll("telegram", "12345", "Alice");
        const decoded = decodeURIComponent(r.otpauthUri);
        assert.match(decoded, /Alice/);
        assert.match(decoded, /12345/);
    });
});

describe("TOTP verify", () => {
    it("accepts a code generated from the same secret", () => {
        const { secret } = enroll("telegram", "alice");
        const code = authenticator.generate(secret);
        assert.equal(verify("telegram", "alice", code), true);
    });

    it("rejects an obviously wrong code", () => {
        enroll("telegram", "alice");
        assert.equal(verify("telegram", "alice", "000000"), false);
    });

    it("rejects a non-6-digit code", () => {
        enroll("telegram", "alice");
        assert.equal(verify("telegram", "alice", "12345"), false);
        assert.equal(verify("telegram", "alice", "1234567"), false);
        assert.equal(verify("telegram", "alice", "abcdef"), false);
        assert.equal(verify("telegram", "alice", ""), false);
    });

    it("rejects when not enrolled", () => {
        assert.equal(verify("telegram", "ghost", "123456"), false);
    });

    it("updates lastVerifiedAt on success", () => {
        const { secret } = enroll("telegram", "alice");
        const before = status("telegram", "alice").lastVerifiedAt;
        assert.equal(before, null);
        const code = authenticator.generate(secret);
        verify("telegram", "alice", code);
        const after = status("telegram", "alice").lastVerifiedAt;
        assert.ok(typeof after === "number" && after > 0);
    });

    it("does not update lastVerifiedAt on failure", () => {
        enroll("telegram", "alice");
        verify("telegram", "alice", "000000");
        assert.equal(status("telegram", "alice").lastVerifiedAt, null);
    });
});

describe("TOTP disable", () => {
    it("removes the vault entry and reports true on first call", () => {
        enroll("telegram", "alice");
        assert.equal(disable("telegram", "alice"), true);
        assert.equal(isEnrolled("telegram", "alice"), false);
        assert.equal(disable("telegram", "alice"), false);
    });

    it("verify returns false after disable", () => {
        const { secret } = enroll("telegram", "alice");
        const code = authenticator.generate(secret);
        assert.equal(verify("telegram", "alice", code), true);
        disable("telegram", "alice");
        assert.equal(verify("telegram", "alice", code), false);
    });
});

describe("TOTP per-user isolation", () => {
    it("alice's secret does not verify bob's codes", () => {
        const aliceSecret = enroll("telegram", "alice").secret;
        enroll("telegram", "bob");
        const aliceCode = authenticator.generate(aliceSecret);
        // Same code, different user → should fail (different secret).
        assert.equal(verify("telegram", "bob", aliceCode), false);
        // Same user → succeeds.
        assert.equal(verify("telegram", "alice", aliceCode), true);
    });

    it("disabling bob does not touch alice", () => {
        enroll("telegram", "alice");
        enroll("telegram", "bob");
        disable("telegram", "bob");
        assert.equal(isEnrolled("telegram", "alice"), true);
        assert.equal(isEnrolled("telegram", "bob"), false);
    });
});

describe("TOTP status", () => {
    it("reports not-enrolled correctly", () => {
        const s = status("telegram", "ghost");
        assert.deepEqual(s, { enrolled: false, enrolledAt: null, lastVerifiedAt: null });
    });

    it("reports enrolled fields after enroll", () => {
        enroll("telegram", "alice");
        const s = status("telegram", "alice");
        assert.equal(s.enrolled, true);
        assert.ok(typeof s.enrolledAt === "number" && s.enrolledAt > 0);
        assert.equal(s.lastVerifiedAt, null);
    });
});

describe("TOTP corrupt-record tolerance", () => {
    it("treats unparseable JSON as not-enrolled", () => {
        // Manually plant a corrupt record. The vault stores the value as a string;
        // setting non-JSON content should make readRecord return null.
        getVault().set("totp:telegram:alice", "not-json{");
        assert.equal(isEnrolled("telegram", "alice"), false);
        assert.equal(verify("telegram", "alice", "123456"), false);
    });

    it("treats record with empty secret as not-enrolled", () => {
        getVault().set("totp:telegram:alice", JSON.stringify({ secret: "", enrolledAt: 1 }));
        assert.equal(isEnrolled("telegram", "alice"), false);
    });
});
