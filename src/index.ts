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
import { TelegramAdapter } from "./transport/telegram.js";
import { ensureInitPasscode, isPasscodeConsumed } from "./core/passcode.js";

// .env carries non-secret runtime config only (BOT_NAME, PRIMARY_PROVIDER,
// REQUIRE_2FA, GUARDRAIL_EMBEDDINGS). Secrets live in the vault.
dotenv.config();

// Daemon mode detection — production VPS deploys run with no TTY (systemd /
// launchd / docker / detached SSH session). InteractiveMode requires a TTY
// to render its TUI. We detect either:
//   - Explicit ORI2_DAEMON=true|false env override (always wins)
//   - Otherwise: process.stdout.isTTY → interactive, else → daemon
// In daemon mode, the bot loads extensions and adapters as usual, then
// blocks on signals. Inbound from network adapters drives the agent.
function isDaemonMode(): boolean {
    const explicit = (process.env["ORI2_DAEMON"] ?? "").toLowerCase();
    if (explicit === "true" || explicit === "1") return true;
    if (explicit === "false" || explicit === "0") return false;
    return !process.stdout.isTTY;
}

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
    // Telegram adapter — always registered. Self-stops cleanly if no
    // TELEGRAM_BOT_TOKEN in vault, surfaces a "needs token" status. Use
    // /connect-telegram <token> from a session to provision it.
    dispatcher.register(new TelegramAdapter());
    const startResult = await dispatcher.startAll();
    if (startResult.failed.length > 0) {
        for (const f of startResult.failed) {
            console.error(`❌ Transport adapter [${f.platform}] failed to start: ${f.error}`);
        }
    }

    console.log(`✅ Platform Ready. Bot Name: [${botName}]`);
    console.log(`📂 Data Storage: ${storagePath}`);
    console.log(`📡 Transport: ${startResult.started.length} adapter${startResult.started.length === 1 ? "" : "s"} registered (${startResult.started.join(", ") || "none"})`);

    // Init passcode — one-time chat-based admin claim. Only generated on fresh
    // installs (see passcode.ts for semantics). Printed ONCE to the terminal
    // so the operator sees it. If missed, /init-status from the terminal
    // re-displays it until consumed.
    if (!isPasscodeConsumed()) {
        const passcode = ensureInitPasscode();
        if (passcode) {
            console.log("");
            console.log("=================================================================");
            console.log("🔑 Admin claim passcode (ONE-TIME, save it if using remotely):");
            console.log(`   ${passcode}`);
            console.log("");
            console.log("   From any configured chat platform (Telegram/Slack/…) send:");
            console.log(`     /init ${passcode}`);
            console.log("   to promote yourself to admin. The passcode is consumed on first");
            console.log("   successful claim. Run /init-status at the terminal to re-display.");
            console.log("=================================================================");
            console.log("");
        }
    }

    console.log(`🔐 Vault Entries: ${getVault().list().length} (keys-only enumeration; values not logged)`);

    // Guardrails: defaults to local fastembed (no API key required). The
    // .pi/extensions/guardrails.ts extension does the actual embed/check.
    // First boot will download the BGE-small ONNX model (~130MB) into
    // data/<BOT_NAME>/.fastembed_cache/ — first user message may be delayed.
    // Set GUARDRAIL_EMBEDDINGS=google|openai in env to use a remote backend instead.

    const projectRoot = process.cwd();
    const daemon = isDaemonMode();

    if (daemon) {
        console.log(`👤 Daemon mode (no TTY, or ORI2_DAEMON=true). Network adapters drive the agent.\n`);

        // In daemon mode we skip InteractiveMode (no TUI to render) and
        // create a single AgentSession directly. Extensions load as usual
        // (this is what gives us tool registration, hooks, etc.). Inbound
        // chat messages from registered adapters trigger the agent via
        // pi.sendUserMessage from transport_bridge.
        const services = await createAgentSessionServices({ cwd: projectRoot });
        await createAgentSessionFromServices({
            services,
            sessionManager: SessionManager.create(storagePath),
        });
        console.log(`✅ Daemon ready. PID=${process.pid}. SIGTERM/SIGINT to stop.`);

        // Block forever — adapters' polling timers and node-schedule cron
        // jobs keep the event loop busy. We also need to handle the shutdown
        // flow cleanly so adapters stop polling before exit.
        await new Promise<void>((resolve) => {
            const stop = async () => {
                console.log("\n[daemon] shutdown signal received");
                await dispatcher.stopAll();
                resolve();
            };
            process.once("SIGINT", () => { void stop(); });
            process.once("SIGTERM", () => { void stop(); });
            process.once("SIGHUP", () => { void stop(); });
        });
        console.log("[daemon] exited cleanly");
        return;
    }

    // Graceful shutdown for interactive mode.
    const shutdown = async () => { await dispatcher.stopAll(); };
    process.on("SIGINT", () => { void shutdown(); });
    process.on("SIGTERM", () => { void shutdown(); });

    console.log("Launching Platform Control Agent...\n");

    // 3. Interactive agent session (The "Control Agent")
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
