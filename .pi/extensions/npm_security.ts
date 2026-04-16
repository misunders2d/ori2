import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";

// Match `npm install`, `npm i`, `yarn add`, `pnpm add`, `pnpm i` at command boundaries
// (start of line/string OR after `;`/`&`/`|`/`&&`/`||`/newline, optionally with `sudo` prefix).
// Defeats the includes("npm install") bypasses (multi-space, mid-cmd, sudo, etc.).
// ANTI-PATTERN A5: do NOT use string.includes() for command detection.
const PKG_INSTALL_REGEX = /(?:^|[;&|\n]|&&|\|\|)\s*(?:sudo\s+)?(?:npm\s+(?:i|install|add)|yarn\s+add|pnpm\s+(?:i|install|add))(?:\s|$)/m;

function runNpm(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
        const proc = spawn("npm", args, { signal });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
        proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
        proc.on("error", reject);
        proc.on("close", (code) => resolve({ stdout, stderr, code }));
    });
}

export default function (pi: ExtensionAPI) {
    pi.on("tool_call", async (event) => {
        if (event.toolName !== "bash") return;
        const cmd = (event.input as { command?: string } | undefined)?.command;
        if (typeof cmd !== "string") return;
        if (PKG_INSTALL_REGEX.test(cmd)) {
            return {
                block: true,
                reason: "SECURITY GUARDRAIL: Raw npm/yarn/pnpm installs via bash are forbidden to prevent supply-chain attacks. Use the 'secure_npm_install' tool which audits the package first.",
            };
        }
        return undefined;
    });

    pi.registerTool({
        name: "secure_npm_install",
        label: "Secure NPM Install",
        description:
            "Safely install npm packages. Runs deprecation, age (typosquatting heuristic), and post-install vulnerability audit. Aborts and uninstalls if any check fails.",
        parameters: Type.Object({
            packages: Type.Array(Type.String(), { description: "Exact package names to install" }),
        }),
        async execute(_id, params, signal, onUpdate) {
            const installed: string[] = [];

            for (const rawPkg of params.packages) {
                const safePkg = rawPkg.replace(/[^a-zA-Z0-9@./_-]/g, "");
                onUpdate?.({ content: [{ type: "text", text: `Running security analysis on '${safePkg}'...` }], details: {} });

                // Step 1: registry check (deprecation + age)
                const info = await runNpm(["info", safePkg, "--json"], signal);
                if (info.code !== 0) {
                    throw new Error(`npm info failed for '${safePkg}': ${info.stderr || `exit ${info.code}`}`);
                }
                let parsed: { deprecated?: string; time?: { created?: string } };
                try {
                    parsed = JSON.parse(info.stdout) as typeof parsed;
                } catch (e) {
                    throw new Error(`Failed to parse npm info for '${safePkg}': ${e instanceof Error ? e.message : String(e)}`);
                }
                if (parsed.deprecated) {
                    throw new Error(`SECURITY BLOCK: '${safePkg}' is deprecated: ${parsed.deprecated}`);
                }
                if (parsed.time?.created) {
                    const daysOld = (Date.now() - new Date(parsed.time.created).getTime()) / (1000 * 60 * 60 * 24);
                    if (daysOld < 14) {
                        throw new Error(
                            `SECURITY BLOCK: '${safePkg}' is suspiciously new (${Math.round(daysOld)} days old). Common typosquat/malware vector.`,
                        );
                    }
                }

                // Step 2: install
                onUpdate?.({ content: [{ type: "text", text: `Registry checks passed. Installing '${safePkg}'...` }], details: {} });
                const inst = await runNpm(["install", safePkg], signal);
                if (inst.code !== 0) {
                    throw new Error(`npm install '${safePkg}' failed: ${inst.stderr || `exit ${inst.code}`}`);
                }

                // Step 3: audit
                onUpdate?.({ content: [{ type: "text", text: `Scanning dependency tree for vulnerabilities...` }], details: {} });
                const audit = await runNpm(["audit", "--audit-level=high"], signal);
                if (audit.code !== 0) {
                    onUpdate?.({ content: [{ type: "text", text: `VULNERABILITY DETECTED. Rolling back '${safePkg}'...` }], details: {} });
                    await runNpm(["uninstall", safePkg], signal);
                    throw new Error(
                        `SECURITY BLOCK: '${safePkg}' installed but failed High-Severity Vulnerability Audit. Package uninstalled.\nAudit:\n${audit.stdout || audit.stderr}`,
                    );
                }
                installed.push(safePkg);
            }

            return {
                content: [{ type: "text", text: `Secure installation complete:\n${installed.map((p) => `✅ ${p}`).join("\n")}` }],
                details: { installed },
            };
        },
    });
}
