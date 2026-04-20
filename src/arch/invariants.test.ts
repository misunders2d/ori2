// Pinned architectural invariants. Fails CI if violated. Do NOT skip/weaken;
// if a rule legitimately changes, update this file AND AGENTS.md in the
// same commit. Companion to src/security/pipeline.test.ts — that file pins
// RUNTIME security; this one pins CODE PATTERNS that survive refactors.

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Walk `dir` and return every file matching one of the extensions. */
function listFiles(dir: string, exts: string[], skip: string[] = []): string[] {
    const out: string[] = [];
    function walk(p: string) {
        if (skip.some((s) => p.includes(s))) return;
        if (!fs.existsSync(p)) return;
        const st = fs.statSync(p);
        if (st.isDirectory()) {
            for (const entry of fs.readdirSync(p)) walk(path.join(p, entry));
        } else if (exts.some((e) => p.endsWith(e))) {
            out.push(p);
        }
    }
    walk(dir);
    return out;
}

const SOURCE_FILES = (): string[] => [
    ...listFiles(path.join(REPO_ROOT, "src"), [".ts"], [".test.ts", "node_modules"]),
    ...listFiles(path.join(REPO_ROOT, ".pi", "extensions"), [".ts"], [".test.ts", "node_modules"]),
];

const EXTENSION_FILES = (): string[] =>
    listFiles(path.join(REPO_ROOT, ".pi", "extensions"), [".ts"], [".test.ts", "node_modules"]);

describe("arch invariant: no shell-interpolated subprocess spawns", () => {
    // Rule 2 (AGENTS.md). Spawning a shell with template-string
    // interpolation of user input is command-injection-adjacent: backticks,
    // $(), newlines in the arg escape the quoting. Use argv form: spawn
    // or execFile with an array of args.
    it("no source file template-interpolates values into a shell-exec template", () => {
        const violations: Array<{ file: string; line: number; snippet: string }> = [];
        // Build the detector regex via RegExp() so the literal bad pattern
        // doesn't appear in this file's source — otherwise static linters
        // flag THIS file as the violation.
        const BAD_CALL = "exec"; // the function-name fragment we're looking for
        const BACKTICK = String.fromCharCode(96);
        const DOLLAR_BRACE = String.fromCharCode(36, 123);
        const CLOSE_BRACE = String.fromCharCode(125);
        const bad = new RegExp(
            `\\b${BAD_CALL}(?:Async)?\\s*\\(\\s*${BACKTICK}[^${BACKTICK}]*\\${DOLLAR_BRACE.charAt(0)}${DOLLAR_BRACE.charAt(1)}[^${CLOSE_BRACE}]+${CLOSE_BRACE}[^${BACKTICK}]*${BACKTICK}`,
        );
        for (const file of SOURCE_FILES()) {
            // Skip THIS file — we compose the bad-pattern dynamically above,
            // which itself contains fragments the regex would false-match on.
            if (file.endsWith("invariants.test.ts")) continue;
            const content = fs.readFileSync(file, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i]!;
                const stripped = line.replace(/\/\/.*$/, "");
                if (bad.test(stripped)) {
                    violations.push({
                        file: path.relative(REPO_ROOT, file),
                        line: i + 1,
                        snippet: line.trim().slice(0, 120),
                    });
                }
            }
        }
        assert.deepEqual(
            violations,
            [],
            `Shell-interpolated exec found. Use argv form. Violations:\n${violations.map((v) => `  ${v.file}:${v.line}  ${v.snippet}`).join("\n")}`,
        );
    });
});

describe("arch invariant: no English-only intent regex", () => {
    // Rule 3 (AGENTS.md). Matching natural-language cancel/stop/abort
    // locks out every non-English speaker. Only ORI2-owned STRUCTURAL
    // commands (prefix like "!", "/", "ACT-") are OK.
    it("no regex matches for cancel/stop/abort/nevermind in conversational form", () => {
        // Detector: a regex-literal containing the English intent alternation
        // with a case-insensitive flag.
        const bad = /\/[^/\n]*\b(?:cancel|stop|abort|nevermind|never\s*mind|halt)\b[^/\n]*\/i/;
        const allowedPrefixMarkers = ["!plan", "@bot-abort", "/init", "/whitelist", "ACT-"];

        // guardrails.ts is exempt: its INJECTION_REGEX is INTENDED to match
        // English attack-vocab (forget|ignore|disregard) because that IS the
        // prompt-injection attack surface. The rule prohibits classifying
        // USER INTENT with English regex — matching attack shape IN DATA is
        // a different (and correct) use.
        const exemptFiles = new Set([
            ".pi/extensions/guardrails.ts",
        ]);

        const violations: Array<{ file: string; line: number; snippet: string }> = [];
        for (const file of SOURCE_FILES()) {
            if (file.endsWith("invariants.test.ts")) continue;
            const rel = path.relative(REPO_ROOT, file);
            if (exemptFiles.has(rel)) continue;
            const content = fs.readFileSync(file, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
                const raw = lines[i]!;
                const stripped = raw.replace(/\/\/.*$/, "");
                if (!bad.test(stripped)) continue;
                if (allowedPrefixMarkers.some((m) => stripped.includes(m))) continue;
                violations.push({
                    file: rel,
                    line: i + 1,
                    snippet: raw.trim().slice(0, 120),
                });
            }
        }
        assert.deepEqual(
            violations,
            [],
            `English-only intent regex found. Delegate intent classification to the LLM. Violations:\n${violations.map((v) => `  ${v.file}:${v.line}  ${v.snippet}`).join("\n")}`,
        );
    });
});

describe("arch invariant: no pi -p subprocess anywhere in source", () => {
    // Both inbound (f69bb81) and scheduler fires (subsequent rewrite) run
    // in-process via createAgentSessionFromServices now. Any new pi -p
    // child-process would re-introduce the event-loop-alive hang class
    // (extensions with persistent timers keep the child alive past the
    // agent reply → proc.on(close) never fires → delivery never runs).
    // Fail CI on reintroduction.
    it("no source file starts pi -p as a child process", () => {
        const violations: string[] = [];
        const re = /\bspawn\s*\(\s*["']([^"']+)["']\s*,\s*\[([^\]]*)\]/g;
        for (const file of SOURCE_FILES()) {
            const content = fs.readFileSync(file, "utf-8");
            let m: RegExpExecArray | null;
            while ((m = re.exec(content)) !== null) {
                const cmd = m[1]!;
                const args = m[2]!;
                const invokesPi =
                    cmd === "pi" ||
                    (cmd === "npx" && /["']pi["']/.test(args));
                if (!invokesPi) continue;
                // Only -p / print-mode is the hazard; `pi --version` etc. are fine.
                if (!/["']-p["']/.test(args)) continue;
                violations.push(
                    `${path.relative(REPO_ROOT, file)}: spawn of pi -p is forbidden; use createAgentSessionFromServices in-process`,
                );
            }
        }
        assert.deepEqual(
            violations,
            [],
            `pi -p child reintroduced. Violations:\n${violations.map((v) => `  ${v}`).join("\n")}`,
        );
    });
});

describe("arch invariant: singletons use getOrCreate(), not module-local let", () => {
    // Rule 4 (AGENTS.md). Pi's jiti (extensions) and tsx (main bootstrap)
    // load modules in separate graphs — module-local `let _instance` is
    // two separate variables. getOrCreate() via globalThis unifies them.
    // See src/core/singletons.ts + Phase 6 of pi-alignment-plan.md.
    it("no file under src/core defines a module-local singleton without getOrCreate", () => {
        const coreDir = path.join(REPO_ROOT, "src", "core");
        const files = listFiles(coreDir, [".ts"], [".test.ts", "singletons.ts"]);

        const violations: string[] = [];
        for (const file of files) {
            const content = fs.readFileSync(file, "utf-8");
            const moduleLocal = /^let\s+_\w+\s*:\s*\w+\s*\|\s*null\s*=\s*null\s*;/m.test(content);
            if (!moduleLocal) continue;
            const importsGetOrCreate = /from\s+["']\.\/singletons\.?(?:js)?["']/.test(content)
                && /getOrCreate/.test(content);
            if (!importsGetOrCreate) {
                violations.push(path.relative(REPO_ROOT, file));
            }
        }
        assert.deepEqual(
            violations,
            [],
            `Module-local singleton found (bypasses cross-graph registry). Violations:\n${violations.map((v) => `  ${v}`).join("\n")}`,
        );
    });
});

describe("arch invariant: extensions cite Pi-API sources", () => {
    // Rule 1 (AGENTS.md). Every extension file should reference the Pi
    // docs or dist source for the APIs it consumes. Soft enforcement via
    // a keyword check.
    it("every .pi/extensions/*.ts non-trivial file references pi-coding-agent docs or types", () => {
        const violations: string[] = [];
        for (const file of EXTENSION_FILES()) {
            const content = fs.readFileSync(file, "utf-8");
            if (content.split("\n").length < 40) continue;
            const referencesPi =
                /pi-coding-agent/.test(content) ||
                /docs\/\w+\.md/.test(content) ||
                /ExtensionAPI/.test(content) ||
                /\bpi\.(?:on|register\w+|sendMessage|sendUserMessage|appendEntry|events)/.test(content);
            if (!referencesPi) {
                violations.push(path.relative(REPO_ROOT, file));
            }
        }
        assert.deepEqual(
            violations,
            [],
            `Non-trivial extension with no reference to Pi APIs / docs:\n${violations.map((v) => `  ${v}`).join("\n")}`,
        );
    });
});

describe("arch invariant: pinned tests are present and non-skipped", () => {
    // Rule 6 (AGENTS.md). The security pipeline + this file are the contract.
    it("src/security/pipeline.test.ts exists", () => {
        assert.ok(fs.existsSync(path.join(REPO_ROOT, "src", "security", "pipeline.test.ts")));
    });

    it("src/arch/invariants.test.ts exists (this file)", () => {
        assert.ok(fs.existsSync(path.join(REPO_ROOT, "src", "arch", "invariants.test.ts")));
    });

    it("pinned test files do NOT contain .skip / it.todo / skipIf", () => {
        const pinned = [
            path.join(REPO_ROOT, "src", "security", "pipeline.test.ts"),
            path.join(REPO_ROOT, "src", "arch", "invariants.test.ts"),
        ];
        // Match actual function-call shape — e.g. `it.skip(`. Trailing `(`
        // excludes string literals in test descriptions that mention the
        // word (this file's own test title is one such false-positive).
        const banned = /\b(?:it|describe|test)\s*\.\s*(?:skip|todo)\s*\(|\bskipIf\s*\(/;
        const violations: string[] = [];
        for (const file of pinned) {
            if (!fs.existsSync(file)) continue;
            const content = fs.readFileSync(file, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
                const stripped = lines[i]!.replace(/\/\/.*$/, "");
                if (banned.test(stripped)) {
                    violations.push(`${path.relative(REPO_ROOT, file)}:${i + 1}: ${lines[i]!.trim().slice(0, 120)}`);
                }
            }
        }
        assert.deepEqual(violations, [], `Banned test-disable construct in pinned test file:\n${violations.join("\n")}`);
    });
});

describe("arch invariant: AGENTS.md is present at repo root", () => {
    // Rule 0 of ori2 conventions: AGENTS.md is the cross-tool spec for
    // dev-agents. Deleting it would orphan every future agent's onboarding.
    it("AGENTS.md exists at repo root and mentions Pi-native philosophy", () => {
        const agentsFile = path.join(REPO_ROOT, "AGENTS.md");
        assert.ok(fs.existsSync(agentsFile), "AGENTS.md missing — it's the dev-agent contract");
        const content = fs.readFileSync(agentsFile, "utf-8");
        assert.match(content, /Pi[- ]native/i, "AGENTS.md should state the Pi-native philosophy");
        assert.match(content, /Hard rules/i, "AGENTS.md should have a Hard rules section");
    });
});

describe("arch invariant: APPEND_SYSTEM.md imposes the two baseline agent defaults", () => {
    // Runtime behavior — every agent turn sees APPEND_SYSTEM.md prepended
    // to its system prompt. Two independent defaults:
    //   (a) DECISION discipline — clarify-before-acting; no silent scope
    //       expansion; YOLO requires explicit approval.
    //   (b) OUTPUT style — terse by default; full prose for security /
    //       destructive / clarifying-question cases.
    // Removing either silently would change user-visible agent behaviour
    // across every fork. Pin both.
    const file = path.join(REPO_ROOT, ".pi", "APPEND_SYSTEM.md");

    it(".pi/APPEND_SYSTEM.md exists", () => {
        assert.ok(fs.existsSync(file), "APPEND_SYSTEM.md missing — no runtime directives will reach the agent");
    });

    it("imposes the clarify-first decision discipline", () => {
        const content = fs.readFileSync(file, "utf-8");
        assert.match(content, /Never assume|clarify first|clarifying question|ambigu/i,
            "APPEND_SYSTEM.md should impose clarify-before-acting decision discipline");
        assert.match(content, /YOLO|explicit approval|use your judgement/i,
            "APPEND_SYSTEM.md should define the explicit-approval / YOLO override");
    });

    it("imposes the terse response-style default", () => {
        const content = fs.readFileSync(file, "utf-8");
        assert.match(content, /caveman-terse|terse by default|Drop\s.+articles/i,
            "APPEND_SYSTEM.md should impose the terse response-style default");
        assert.match(content, /Revert to normal prose|security warnings/i,
            "APPEND_SYSTEM.md terse section should document when to revert to normal prose");
    });
});
