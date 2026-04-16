import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
    scanContent,
    checkFilename,
    shannonEntropyBits,
    HARD_FORBIDDEN_FILENAMES,
    KNOWN_PATTERNS,
    ENTROPY_THRESHOLD_BITS_PER_CHAR,
} from "./secretScanner.js";

describe("checkFilename", () => {
    it(".env and .env.* hit", () => {
        assert.ok(checkFilename(".env"));
        assert.ok(checkFilename(".env.local"));
        assert.ok(checkFilename(".env.production"));
        assert.ok(checkFilename("/abs/.env"));
    });

    it("vault.json, oauth_tokens.json, credentials.json hit", () => {
        assert.ok(checkFilename("vault.json"));
        assert.ok(checkFilename("data/bot/vault.json"));
        assert.ok(checkFilename("oauth_tokens.json"));
        assert.ok(checkFilename("credentials.json"));
    });

    it(".pem, .key, id_rsa* hit", () => {
        assert.ok(checkFilename("server.pem"));
        assert.ok(checkFilename("private.key"));
        assert.ok(checkFilename("id_rsa"));
        assert.ok(checkFilename("id_rsa.pub"));
        assert.ok(checkFilename("id_ed25519"));
    });

    it("normal source files do NOT hit", () => {
        assert.equal(checkFilename(".pi/extensions/clickup.ts"), null);
        assert.equal(checkFilename("README.md"), null);
        assert.equal(checkFilename("config.ts"), null);
    });

    it("HARD_FORBIDDEN_FILENAMES is sourced from a real list (sanity)", () => {
        assert.ok(HARD_FORBIDDEN_FILENAMES.length >= 5);
    });
});

describe("shannonEntropyBits", () => {
    it("low entropy on repetitive content", () => {
        // "aaaa...32x" → entropy = 0
        assert.equal(shannonEntropyBits("a".repeat(32)), 0);
    });

    it("high entropy on random hex", () => {
        // 64-char random hex (alphabet 16) — entropy ≈ 4 bits/char
        const hex = "0123456789abcdef".repeat(4);
        const e = shannonEntropyBits(hex);
        assert.ok(e >= 3.9 && e <= 4.1, `expected ~4 bits/char, got ${e}`);
    });

    it("very high entropy on random base64-ish", () => {
        // Mixed-case + digits + symbols — should clear our 4.5 threshold
        const s = "Aa1+Bb2/Cc3=Dd4!Ee5@Ff6#Gg7$Hh8%Ii9^Jj0&";
        assert.ok(shannonEntropyBits(s) > ENTROPY_THRESHOLD_BITS_PER_CHAR);
    });
});

describe("scanContent — regex pass", () => {
    it("flags an Anthropic key", () => {
        const content = `const k = "sk-ant-${"A1b2C3d4E5".repeat(5)}";`;
        const findings = scanContent("foo.ts", content);
        assert.ok(findings.some((f) => f.kind === "regex" && f.pattern === "anthropic-key"));
    });

    it("flags a Google API key", () => {
        const content = `const k = "AIza${"x".repeat(35)}";`;
        const findings = scanContent("foo.ts", content);
        assert.ok(findings.some((f) => f.kind === "regex" && f.pattern === "google-api-key"));
    });

    it("flags a GitHub classic PAT", () => {
        const content = `const k = "ghp_${"A".repeat(36)}";`;
        const findings = scanContent("foo.ts", content);
        assert.ok(findings.some((f) => f.kind === "regex" && f.pattern === "github-classic-pat"));
    });

    it("flags an env-style assignment", () => {
        const content = `STRIPE_API_KEY = 'rk_live_supersecret_value_here'`;
        const findings = scanContent("foo.env", content);
        assert.ok(findings.some((f) => f.kind === "regex" && f.pattern === "env-style-secret"));
    });

    it("flags a private key header", () => {
        const content = "Some text\n-----BEGIN RSA PRIVATE KEY-----\nMIIE...";
        const findings = scanContent("foo.ts", content);
        assert.ok(findings.some((f) => f.kind === "regex" && f.pattern === "private-key-header"));
    });

    it("does NOT flag innocuous code", () => {
        const content = `import path from "node:path";\nconst greeting = "hello world";`;
        const findings = scanContent("foo.ts", content);
        assert.equal(findings.length, 0);
    });

    it("reports correct line + column", () => {
        const content = "// header\n// header2\nconst k = \"AIza" + "x".repeat(35) + "\";";
        const findings = scanContent("foo.ts", content);
        const f = findings.find((x) => x.pattern === "google-api-key");
        assert.ok(f);
        assert.equal(f!.line, 3);
        assert.ok(f!.column > 0);
    });

    it("each KNOWN_PATTERNS entry has a global regex", () => {
        for (const p of KNOWN_PATTERNS) {
            assert.ok(p.re.flags.includes("g"), `${p.name} regex must have global flag`);
        }
    });
});

describe("scanContent — entropy pass", () => {
    it("flags a high-entropy string literal", () => {
        const content = `const x = "Aa1+Bb2/Cc3=Dd4!Ee5@Ff6#Gg7$Hh8%Ii9^Jj0&Kk1*";`;
        const findings = scanContent("foo.ts", content);
        assert.ok(findings.some((f) => f.kind === "entropy"));
    });

    it("does NOT double-flag a string already caught by the regex pass", () => {
        const content = `const k = "AIza${"x".repeat(35)}";`;
        const findings = scanContent("foo.ts", content);
        // Should have exactly one finding (regex), no entropy duplicate.
        const regexFindings = findings.filter((f) => f.kind === "regex");
        const entropyFindings = findings.filter((f) => f.kind === "entropy");
        assert.equal(regexFindings.length, 1);
        assert.equal(entropyFindings.length, 0);
    });

    it("does NOT flag low-entropy string literals", () => {
        const content = `const x = "this is a long but human-readable sentence in english here";`;
        const findings = scanContent("foo.ts", content).filter((f) => f.kind === "entropy");
        assert.equal(findings.length, 0);
    });

    it("ignores short strings", () => {
        const content = `const x = "short";`;
        const findings = scanContent("foo.ts", content);
        assert.equal(findings.length, 0);
    });
});

describe("Finding.lineHash", () => {
    it("is stable for the same line content", () => {
        const a = scanContent("a.ts", `const k = "AIza${"x".repeat(35)}";`)[0]!;
        const b = scanContent("b.ts", `const k = "AIza${"x".repeat(35)}";`)[0]!;
        assert.equal(a.lineHash, b.lineHash);
    });

    it("differs when the line content differs", () => {
        const a = scanContent("a.ts", `const a = "AIza${"x".repeat(35)}";`)[0]!;
        const b = scanContent("a.ts", `const b = "AIza${"x".repeat(35)}";`)[0]!;
        assert.notEqual(a.lineHash, b.lineHash);
    });
});
