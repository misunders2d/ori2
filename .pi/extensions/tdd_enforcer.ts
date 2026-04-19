import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile } from "child_process";
import { promisify } from "util";
import { auditSessionForEvolution } from "../../src/core/evolutionAudit.js";
import { scanContent, type Finding } from "../../src/a2a/secretScanner.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// tdd_enforcer — the FINAL evolution gate. Four checks run BEFORE committing:
//
//   1. Phase-1 safety-ack present AND user_acknowledged=true
//      (auditSessionForEvolution)
//   2. Phase-2 prior-art-search recorded
//      (auditSessionForEvolution)
//   3. Staged diff contains no leaked secrets
//      (scanContent across `git diff --cached`)
//   4. Full `npm test` passes
//
// Any one failing = commit refused. Checks 1-3 run first so the agent gets
// fast feedback on procedural misses before spending minutes on the test run.
//
// All git / npm invocations use execFile (argv form) — no shell, so commit
// messages and other user-controlled strings can't inject.
// =============================================================================

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "verify_and_commit",
        label: "Verify & Commit",
        description:
            "The mandatory finalization tool for evolutions. Runs FOUR gates in order: " +
            "(1) Phase 1 safety briefing must be recorded via evolve_safety_ack + user must have " +
            "acknowledged; (2) Phase 2 prior-art search must be recorded via " +
            "evolution_prior_art_search; (3) the staged diff is scanned for leaked secrets; " +
            "(4) the full test suite runs. If any gate fails, the commit is refused with a " +
            "specific remedy. Tests pass + no secrets + both evolution entries present = commit.",
        parameters: Type.Object({
            commit_message: Type.String({ description: "A clear description of the feature or fix" }),
        }),
        async execute(_id, params, _signal, onUpdate, ctx) {
            // --- Gate 1 + 2: Evolution-sop discipline ---
            const branch = ctx.sessionManager.getBranch();
            const audit = auditSessionForEvolution(branch);
            if (!audit.hasValidPriorArt || !audit.hasValidSafetyAck) {
                return {
                    content: [{
                        type: "text",
                        text:
                            `EVOLUTION GATE: commit refused — evolution-sop discipline not satisfied.\n\n` +
                            audit.remedy +
                            `\n\nWhat's present so far:\n` +
                            `  - prior-art: ${audit.hasValidPriorArt ? "OK" : "MISSING"}\n` +
                            `  - safety-ack: ${audit.hasValidSafetyAck ? "OK" : "MISSING / user_acknowledged=false"}\n`,
                    }],
                    details: { committed: false, reason: "evolution-sop-gate", audit },
                };
            }

            // --- Gate 3: Stage + secret-scan the staged diff ---
            onUpdate?.({ content: [{ type: "text", text: `Staging + scanning diff for leaked secrets...` }], details: {} });
            try {
                await execFileAsync("git", ["add", "."]);
            } catch (err: unknown) {
                return {
                    content: [{
                        type: "text",
                        text: `git add failed — is this a git repo? ${err instanceof Error ? err.message : String(err)}`,
                    }],
                    details: { committed: false, reason: "git-add-failed" },
                };
            }

            const secretFindings = await scanStagedDiffForSecrets();
            if (secretFindings.length > 0) {
                const report = secretFindings
                    .slice(0, 10)
                    .map((f) => `  • ${f.filePath}:${f.line} [${f.kind}:${f.name}] — ${truncate(f.matched, 80)}`)
                    .join("\n");
                return {
                    content: [{
                        type: "text",
                        text:
                            `SECRET GATE: commit refused — ${secretFindings.length} potential secret(s) found in the staged diff:\n\n` +
                            report +
                            (secretFindings.length > 10 ? `\n  … and ${secretFindings.length - 10} more.` : "") +
                            `\n\nFix: remove hardcoded values. Route real secrets through /credentials add or /oauth connect; ` +
                            `reference them via the credentials API at call-time, never inline.`,
                    }],
                    details: { committed: false, reason: "secret-scanner", findings: secretFindings.slice(0, 50) },
                };
            }

            // --- Gate 4: Full test suite ---
            onUpdate?.({ content: [{ type: "text", text: `Running platform test suite...` }], details: {} });
            let stdout = "";
            try {
                const res = await execFileAsync("npm", ["run", "test"]);
                stdout = res.stdout;
            } catch (error: unknown) {
                const e = error as { stdout?: string; stderr?: string; message?: string };
                return {
                    content: [{
                        type: "text",
                        text:
                            `TEST GATE: commit refused — tests failed.\n\n` +
                            `You MUST fix these failures and re-run verify_and_commit.\n\n` +
                            `TEST TRACE:\n${e.stdout ?? ""}\n${e.stderr ?? e.message ?? ""}`,
                    }],
                    details: { committed: false, reason: "tests-failed", error: e.message ?? "test failure" },
                };
            }

            onUpdate?.({ content: [{ type: "text", text: `All gates passed. Committing...` }], details: {} });

            // --- Commit + push (push best-effort) ---
            try {
                await execFileAsync("git", [
                    "commit",
                    "-m",
                    buildCommitMessage(params.commit_message, audit),
                ]);
                await execFileAsync("git", ["push"]).catch(() => { /* best effort */ });
            } catch (err: unknown) {
                const e = err as { stdout?: string; stderr?: string; message?: string };
                return {
                    content: [{
                        type: "text",
                        text: `git commit failed after all gates passed: ${e.stderr ?? e.message ?? "unknown"}`,
                    }],
                    details: { committed: false, reason: "git-commit-failed" },
                };
            }

            return {
                content: [{
                    type: "text",
                    text:
                        `SUCCESS: all four gates passed (safety, prior-art, secrets, tests). Committed.\n\n` +
                        `Audit trail:\n` +
                        `  - prior-art domain: ${audit.mostRecentPriorArt?.domain ?? "?"} (${audit.mostRecentPriorArt?.conclusion ?? "?"})\n` +
                        `  - safety-ack domain: ${audit.mostRecentSafetyAck?.domain ?? "?"} (${audit.mostRecentSafetyAck?.risks_count ?? 0} risks, user_acknowledged=true)\n` +
                        `  - staged secret findings: 0\n` +
                        `  - tests: passed\n\n` +
                        `Test Output (tail):\n${stdout.slice(-2000)}`,
                }],
                details: { committed: true, message: params.commit_message, audit },
            };
        },
    });
}

function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Scan the staged diff for leaked secrets. Extracts added lines per file from
 * `git diff --cached` and runs each file's added content through scanContent()
 * — same detection surface used by DNA export for consistency.
 */
async function scanStagedDiffForSecrets(): Promise<Finding[]> {
    let diff = "";
    try {
        const res = await execFileAsync("git", ["diff", "--cached", "--no-color", "--unified=0"]);
        diff = res.stdout;
    } catch {
        // Broken git → return no findings. The audit + test gates still run;
        // a truly broken git repo will surface at the later commit step anyway.
        return [];
    }
    if (!diff.trim()) return [];

    const findings: Finding[] = [];
    const files = diff.split(/^diff --git /m).slice(1);
    for (const fileBlock of files) {
        const firstLine = fileBlock.split("\n", 1)[0] ?? "";
        // `diff --git a/<path> b/<path>`
        const pathMatch = /\sb\/(.+)$/.exec(firstLine);
        const filePath = pathMatch ? pathMatch[1]! : "unknown";
        const addedLines: string[] = [];
        for (const line of fileBlock.split("\n")) {
            if (line.startsWith("+++") || line.startsWith("---")) continue;
            if (line.startsWith("+")) addedLines.push(line.slice(1));
        }
        if (addedLines.length === 0) continue;
        const addedContent = addedLines.join("\n");
        const perFile = scanContent(filePath, addedContent);
        findings.push(...perFile);
    }
    return findings;
}

function buildCommitMessage(userMessage: string, audit: ReturnType<typeof auditSessionForEvolution>): string {
    const trailer =
        `\n\nEvolution-gate audit:\n` +
        `  prior-art: domain=${audit.mostRecentPriorArt?.domain ?? "?"} conclusion=${audit.mostRecentPriorArt?.conclusion?.slice(0, 60) ?? "?"}\n` +
        `  safety-ack: domain=${audit.mostRecentSafetyAck?.domain ?? "?"} risks=${audit.mostRecentSafetyAck?.risks_count ?? 0} user_acknowledged=true`;
    return userMessage + trailer;
}
