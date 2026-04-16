import {
    SessionManager,
    createAgentSessionRuntime,
    createAgentSessionServices,
    createAgentSessionFromServices,
    getAgentDir,
    InteractiveMode,
    type CreateAgentSessionRuntimeFactory,
} from "@mariozechner/pi-coding-agent";
import dotenv from "dotenv";
import { runOnboardingFlow, isSystemConfigured } from "./onboarding/setup.js";
import { acquireInstanceLock } from "./core/instanceLock.js";
import { botDir, ensureDir, getBotName } from "./core/paths.js";
import { getVault } from "./core/vault.js";
import { getDispatcher } from "./transport/dispatcher.js";
import { CliAdapter } from "./transport/cli.js";

// .env carries non-secret runtime config only (BOT_NAME, PRIMARY_PROVIDER,
// REQUIRE_2FA, GUARDRAIL_EMBEDDINGS). Secrets live in the vault.
dotenv.config();

// Keys the vault is authoritative for. After vault load these are pushed into
// process.env so any code path that still reads them by name (Pi's auth flow,
// 3rd-party SDKs, our extensions) finds them. Vault is the source of truth;
// process.env is a derived view for compatibility.
const VAULT_HYDRATED_KEYS = [
    "ADMIN_USER_IDS",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "OPENAI_API_KEY",
] as const;

function hydrateEnvFromVault(): void {
    const vault = getVault();
    for (const key of VAULT_HYDRATED_KEYS) {
        const v = vault.get(key);
        if (v !== undefined && v !== "") process.env[key] = v;
    }
}

async function bootstrap() {
    console.log("🚀 Bootstrapping Ori2 Foundational Platform...");

    // 1. User Onboarding & Vault Setup
    if (!isSystemConfigured()) {
        console.log("⚠️ System unconfigured. Launching First-Time Onboarding...");
        await runOnboardingFlow();
        // Wizard wrote .env (BOT_NAME, etc.) AND vault (secrets). Reload .env
        // so BOT_NAME is in process.env for botDir() etc.
        dotenv.config({ override: true });
    }

    // 2. Platform Services Setup
    const botName = getBotName();
    const storagePath = botDir();
    ensureDir(storagePath);

    // Hydrate process.env from vault BEFORE any extension or Pi component reads
    // these keys. After this point, every subsequent process.env access for a
    // vault-backed key returns the vault value.
    hydrateEnvFromVault();

    // Lock the instance — a second bot with the same name would corrupt
    // sessions/vault/memory.
    acquireInstanceLock(storagePath, botName);

    // Transport dispatcher — singleton hub between adapters and Pi runtime.
    // CLI adapter is the only built-in baseline adapter; Telegram (Sprint 4),
    // Slack (future), and Synapse-A2A (Sprint 9) register the same way.
    const dispatcher = getDispatcher();
    dispatcher.register(new CliAdapter());
    const startResult = await dispatcher.startAll();
    if (startResult.failed.length > 0) {
        for (const f of startResult.failed) {
            console.error(`❌ Transport adapter [${f.platform}] failed to start: ${f.error}`);
        }
    }

    console.log(`✅ Platform Ready. Bot Name: [${botName}]`);
    console.log(`📂 Data Storage: ${storagePath}`);
    console.log(`🔐 Vault Entries: ${getVault().list().length} (keys-only enumeration; values not logged)`);
    console.log(`📡 Transport: ${startResult.started.length} adapter${startResult.started.length === 1 ? "" : "s"} registered (${startResult.started.join(", ") || "none"})`);

    // Graceful shutdown — stop adapters before exit.
    const shutdown = async () => {
        await dispatcher.stopAll();
    };
    process.on("SIGINT", () => { void shutdown(); });
    process.on("SIGTERM", () => { void shutdown(); });

    // Guardrails: defaults to local fastembed (no API key required). The
    // .pi/extensions/guardrails.ts extension does the actual embed/check.
    // First boot will download the BGE-small ONNX model (~130MB) into
    // data/<BOT_NAME>/.fastembed_cache/ — first user message may be delayed.
    // Set GUARDRAIL_EMBEDDINGS=google|openai in env to use a remote backend instead.

    console.log("Launching Platform Control Agent...\n");

    // 3. Launching the interactive agent session (The "Control Agent")
    //
    // cwd = project root (process.cwd()) so Pi auto-discovers our
    // .pi/extensions/, .pi/skills/, .pi/prompts/ from the codebase. The agent's
    // bash/read/write tools also operate from project root, which is what we
    // want for the evolution surface (the agent edits its own extensions in
    // .pi/extensions/).
    //
    // SessionManager.create(storagePath) keeps session JSONL files per-bot in
    // data/<BOT_NAME>/. All other per-bot runtime data (vault, memory,
    // active-plans, etc.) is also written under data/<BOT_NAME>/ via the
    // botDir() helper in src/core/paths.ts.
    const projectRoot = process.cwd();
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
        const services = await createAgentSessionServices({ cwd: projectRoot });
        return {
            ...(await createAgentSessionFromServices({
                services,
                sessionManager,
                ...(sessionStartEvent ? { sessionStartEvent } : {}),
            })),
            services,
            diagnostics: services.diagnostics,
        };
    };

    const runtime = await createAgentSessionRuntime(createRuntime, {
        cwd: projectRoot,
        agentDir: getAgentDir(),
        sessionManager: SessionManager.create(storagePath),
    });

    const mode = new InteractiveMode(runtime, {
        migratedProviders: [],
        initialImages: [],
        initialMessages: [],
    });

    // This takes over the terminal and starts the Pi UI!
    await mode.run();
}

bootstrap().catch(console.error);
