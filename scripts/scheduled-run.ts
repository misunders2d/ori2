import {
    SessionManager,
    createAgentSessionServices,
    createAgentSessionFromServices,
    getAgentDir,
} from "@mariozechner/pi-coding-agent";
import dotenv from "dotenv";
import { botDir, ensureDir, getBotName } from "../src/core/paths.js";
import { getVault } from "../src/core/vault.js";
import { getDispatcher } from "../src/transport/dispatcher.js";
import { CliAdapter } from "../src/transport/cli.js";
import { TelegramAdapter } from "../src/transport/telegram.js";

// =============================================================================
// scripts/scheduled-run.ts — subprocess agent runner.
//
// Spawned by the scheduler extension on each cron fire. Each run:
//   1. Receives the session-file path on argv[2] (created by parent + optionally
//      seedPlan'd before spawn).
//   2. Loads env + vault (same hydration as the parent's bootstrap).
//   3. Registers transport adapters BUT DOES NOT START THEM. Their inbound
//      pollers (Telegram getUpdates) continue running in the parent process;
//      starting a second poller would race for Updates. Outbound sends still
//      work — adapter.send() just POSTs to the platform API.
//   4. Creates an AgentSession against the seeded session file.
//   5. Calls session.prompt(<kickoff>) and waits for resolution.
//   6. Exits when the agent has settled.
//
// Plan-enforcement integration:
//   If the parent called seedPlan() before spawning, the session already has
//   a plan-enforcer custom entry. plan_enforcer's session_start handler will
//   pick it up and the agent's first turn will see "[🚨 PLAN ENFORCEMENT
//   MODE ACTIVE 🚨]" in its system prompt with the first step. Completion or
//   failure routes to data/<bot>/plan-reports/ via the existing disk fallback.
//
// Direct invocation:
//   tsx scripts/scheduled-run.ts <session-file-path> [<kickoff-text>]
//
// Exit codes:
//   0 — agent run completed cleanly
//   1 — invalid args / setup failure
//   2 — agent run threw
// =============================================================================

const DEFAULT_KICKOFF = "[SCHEDULED] Begin executing the seeded plan or task. Report results when complete.";

// Mirrors src/index.ts VAULT_HYDRATED_KEYS. Keep in sync — the subprocess
// runs in a fresh Node process so it must do its own hydration. GEMINI_API_KEY
// is Pi's canonical env-var name for the Google provider (not GOOGLE_API_KEY —
// see @mariozechner/pi-ai/dist/env-api-keys.js).
const VAULT_HYDRATED_KEYS = [
    "ADMIN_USER_IDS",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
] as const;

function migrateLegacyVaultKeys(): void {
    const vault = getVault();
    const legacy = vault.get("GOOGLE_API_KEY");
    const canonical = vault.get("GEMINI_API_KEY");
    if (legacy && !canonical) {
        vault.set("GEMINI_API_KEY", legacy);
        vault.delete("GOOGLE_API_KEY");
        console.log("🔧 [vault] migrated GOOGLE_API_KEY → GEMINI_API_KEY");
    }
}

function hydrateEnvFromVault(): void {
    const vault = getVault();
    for (const key of VAULT_HYDRATED_KEYS) {
        const v = vault.get(key);
        if (v !== undefined && v !== "") process.env[key] = v;
    }
    // Alias for guardrails' Google-embed backend (Google AI Studio accepts
    // either name; see src/index.ts for the same mirror).
    const gemini = process.env["GEMINI_API_KEY"];
    if (gemini && !process.env["GOOGLE_API_KEY"]) process.env["GOOGLE_API_KEY"] = gemini;
}

async function main(): Promise<number> {
    dotenv.config();

    const sessionFile = process.argv[2];
    const kickoff = process.argv[3] ?? DEFAULT_KICKOFF;

    if (!sessionFile) {
        console.error("Usage: scheduled-run.ts <session-file-path> [<kickoff-text>]");
        return 1;
    }

    const botName = getBotName();
    const storagePath = botDir();
    ensureDir(storagePath);
    migrateLegacyVaultKeys();
    hydrateEnvFromVault();

    console.log(`[scheduled-run] bot=${botName} session=${sessionFile}`);

    // Register transport adapters so transport_bridge's agent_end hook can
    // route the agent's response back out — but DO NOT call startAll().
    // Inbound polling stays in the parent; this subprocess is send-only.
    const dispatcher = getDispatcher();
    dispatcher.register(new CliAdapter());
    dispatcher.register(new TelegramAdapter());

    // Open the existing (seeded) session file.
    const sm = SessionManager.open(sessionFile);

    // Build the agent session against the project root so all .pi/extensions/
    // (plan_enforcer, persona, guardrails, etc.) load. cwd = project root
    // matches the parent bootstrap's cwd choice.
    const projectRoot = process.cwd();
    const services = await createAgentSessionServices({ cwd: projectRoot });
    const { session } = await createAgentSessionFromServices({
        services,
        sessionManager: sm,
    });

    // Drive one prompt. AgentSession.prompt() resolves when the turn (and
    // any tool-call chain it triggered) settles. plan_enforcer's
    // before_agent_start sees the seeded plan and steers the agent.
    try {
        await session.prompt(kickoff);
    } catch (e) {
        console.error("[scheduled-run] prompt() threw:", e);
        return 2;
    }

    // Drain any queued steering / followup messages plan_enforcer may have
    // pushed via plan_complete_step → sendUserMessage(deliverAs:"followUp").
    // No public "is settled" API; give the event loop a moment.
    await new Promise((resolve) => setTimeout(resolve, 500));

    console.log(`[scheduled-run] complete (session=${sm.getSessionFile() ?? "(in-memory)"})`);
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((e) => {
        console.error("[scheduled-run] fatal:", e);
        process.exit(2);
    });
