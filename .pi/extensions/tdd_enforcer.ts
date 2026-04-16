import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "verify_and_commit",
        label: "Verify & Commit",
        description: "The mandatory tool to finalize a feature or code update. It automatically runs the test suite. If tests fail, the commit is aborted and errors are returned. If they pass, the code is safely committed.",
        parameters: Type.Object({
            commit_message: Type.String({ description: "A clear description of the feature or fix" })
        }),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            onUpdate?.({ content: [{ type: "text", text: `Running platform test suite...` }], details: {} });
            
            try {
                // Step 1: Force a test run
                const { stdout, stderr } = await execAsync(`npm run test`);
                
                onUpdate?.({ content: [{ type: "text", text: `Tests passed! Committing code...` }], details: {} });
                
                // Step 2: Ensure git is initialized (fallback for fresh installs)
                await execAsync(`git init`).catch(() => {});
                
                // Step 3: Stage and commit
                await execAsync(`git add .`);
                await execAsync(`git commit -m "${params.commit_message.replace(/"/g, '\\"')}"`);

                // Step 4: Try to push to remote (fails silently if no remote is configured yet)
                await execAsync(`git push origin main`).catch(() => {});

                return {
                    content: [{ type: "text", text: `SUCCESS: Tests passed and code was committed.\nTest Output:\n${stdout}` }],
                    details: { committed: true, message: params.commit_message },
                };

            } catch (error: unknown) {
                const e = error as { stdout?: string; stderr?: string; message?: string };
                return {
                    content: [{
                        type: "text",
                        text: `SECURITY BLOCK: Commit aborted. Your code failed the test suite.\n\nYou MUST fix these errors and re-run verify_and_commit.\n\nTEST TRACE:\n${e.stdout ?? ""}\n${e.stderr ?? e.message ?? ""}`,
                    }],
                    details: { committed: false, error: e.message ?? "test failure" },
                };
            }
        }
    });
}
