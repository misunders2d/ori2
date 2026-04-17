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
import { botDir, botSubdir, ensureDir, getBotName } from "./core/paths.js";
import { getVault } from "./core/vault.js";
import { getDispatcher } from "./transport/dispatcher.js";
import { CliAdapter } from "./transport/cli.js";
import { TelegramAdapter } from "./transport/telegram.js";
import { ensureInitPasscode, isPasscodeConsumed } from "./core/passcode.js";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getA2AAdapter } from "./a2a/adapter.js";
import { setA2AServerHandle, startA2AServer, type A2AServerHandle } from "./a2a/server.js";
import { TunnelManager, type TunnelMode } from "./a2a/tunnel.js";
import { broadcastAddressUpdate } from "./a2a/broadcaster.js";
import { logError, logWarning } from "./core/errorLog.js";
import { startProactiveDiagnostics } from "./core/proactiveDiagnostics.js";
import {
    migrateLegacyVaultKeys as _migrateLegacyVaultKeys,
    ensurePiAuthJsonSeeded as _ensurePiAuthJsonSeeded,
    ensurePiSettingsJsonSeeded as _ensurePiSettingsJsonSeeded,
} from "./core/piSeed.js";

// .env carries non-secret runtime config only (BOT_NAME, REQUIRE_2FA,
// GUARDRAIL_EMBEDDINGS). Secrets live in the vault. Pi settings
// (defaultProvider/defaultModel/etc.) live in Pi's settings.json at
// <PI_CODING_AGENT_DIR>/settings.json — NOT in .env.
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

// Keys the vault mirrors into process.env on boot. Vault is our store of
// record; env-var hydration is a fallback for code paths that read env
// directly (Telegram token, guardrails' remote-embed backend, etc.).
//
// Pi SDK's own resolution order is: --api-key flag > auth.json > env vars
// > models.json (pi-coding-agent/docs/providers.md §Resolution Order). The
// wizard writes auth.json alongside the vault, so Pi picks up credentials
// from auth.json — these env vars are only needed by our own code.
//
// NAMING: the LLM provider env vars use Pi's canonical names — per
// @mariozechner/pi-ai/dist/env-api-keys.js, `google` maps to GEMINI_API_KEY
// (NOT GOOGLE_API_KEY — that's Vertex territory). The migration below
// renames legacy vaults that still have GOOGLE_API_KEY.
const VAULT_HYDRATED_KEYS = [
    "ADMIN_USER_IDS",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
] as const;

function migrateLegacyVaultKeys(): void {
    if (_migrateLegacyVaultKeys()) {
        console.log("🔧 [vault] migrated GOOGLE_API_KEY → GEMINI_API_KEY (Pi SDK canonical name)");
    }
}

function hydrateEnvFromVault(): void {
    const vault = getVault();
    for (const key of VAULT_HYDRATED_KEYS) {
        const v = vault.get(key);
        if (v !== undefined && v !== "") process.env[key] = v;
    }
    // Note: we used to mirror GEMINI_API_KEY → GOOGLE_API_KEY here for
    // guardrails' Google-embed backend. guardrails.ts now reads
    // GEMINI_API_KEY directly (Pi's canonical name), so the mirror is gone.
    // That also kills the "Both GOOGLE_API_KEY and GEMINI_API_KEY are set"
    // noise `pi -p` subprocesses would emit when they saw both vars.
}

function ensurePiAuthJsonSeeded(): void {
    const piDir = process.env["PI_CODING_AGENT_DIR"];
    if (!piDir) return;
    if (_ensurePiAuthJsonSeeded(piDir)) {
        console.log(`🔧 [pi-auth] seeded auth.json from vault (${path.join(piDir, "auth.json")})`);
    }
}

function ensurePiSettingsJsonSeeded(): void {
    const piDir = process.env["PI_CODING_AGENT_DIR"];
    if (!piDir) return;
    if (_ensurePiSettingsJsonSeeded(piDir)) {
        console.log(`🔧 [pi-settings] seeded defaultProvider (${path.join(piDir, "settings.json")})`);
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

    // Pi-state isolation: pin PI_CODING_AGENT_DIR per-bot so Pi's global
    // config (auth.json, models.json, settings.json, themes, debug log)
    // lives under data/<BOT>/.pi-state/ instead of the OS-user-wide
    // ~/.pi/agent/. Without this, every ori2 bot run by the same OS user
    // shares ~/.pi/agent/ and concurrent writes race. systemd/launchd units
    // set this explicitly; this default covers `npm start` so plain
    // interactive launches are also per-checkout-isolated.
    if (!process.env["PI_CODING_AGENT_DIR"]) {
        const piStateDir = botSubdir(".pi-state");
        ensureDir(piStateDir);
        process.env["PI_CODING_AGENT_DIR"] = piStateDir;
    }

    // Migrate legacy vault keys (GOOGLE_API_KEY → GEMINI_API_KEY) before
    // hydration so the renamed key lands in process.env.
    migrateLegacyVaultKeys();

    // Hydrate process.env from vault BEFORE any extension or Pi component reads
    // these keys. After this point, every subsequent process.env access for a
    // vault-backed key returns the vault value.
    hydrateEnvFromVault();

    // Seed Pi's native auth.json + settings.json from vault if missing. This
    // covers installs that predate the wizard writing these files. Safe to
    // run on every boot — both functions are idempotent and respect any
    // values the operator set via /login or /settings.
    ensurePiAuthJsonSeeded();
    ensurePiSettingsJsonSeeded();

    // Lock the instance — a second bot with the same name would corrupt
    // sessions/vault/memory.
    acquireInstanceLock(storagePath, botName);

    // Transport dispatcher — singleton hub between adapters and Pi runtime.
    // CLI adapter is the only built-in baseline adapter; Telegram (Sprint 4),
    // Slack (future), and A2A (peer-to-peer) register the same way.
    const dispatcher = getDispatcher();
    dispatcher.register(new CliAdapter());
    // Telegram adapter — always registered. Self-stops cleanly if no
    // TELEGRAM_BOT_TOKEN in vault, surfaces a "needs token" status. Use
    // /connect-telegram <token> from a session to provision it.
    dispatcher.register(new TelegramAdapter());
    // A2A adapter — peer-to-peer agent communication. Server lifecycle is
    // separate (startA2A below); this just registers the routing target so
    // dispatcher.send("a2a", ...) reaches us.
    dispatcher.register(getA2AAdapter());
    const startResult = await dispatcher.startAll();
    if (startResult.failed.length > 0) {
        for (const f of startResult.failed) {
            logError("bootstrap", `Transport adapter [${f.platform}] failed to start`, { platform: f.platform, err: f.error });
        }
    }

    console.log(`✅ Platform Ready. Bot Name: [${botName}]`);
    console.log(`📂 Data Storage: ${storagePath}`);
    console.log(`📡 Transport: ${startResult.started.length} adapter${startResult.started.length === 1 ? "" : "s"} registered (${startResult.started.join(", ") || "none"})`);

    // A2A subsystem — peer-to-peer agent communication. Non-fatal: any failure
    // here logs loudly but never kills the rest of the bot. /a2a status from
    // chat reports the diagnosed state.
    await startA2A(botName).catch((e: unknown) => {
        logWarning("a2a-bootstrap", `A2A subsystem failed to start`, { err: e instanceof Error ? e.message : String(e) });
    });

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

    // Proactive diagnostics — periodic health checks with admin DM on
    // degradation. Non-fatal if misconfigured.
    try { startProactiveDiagnostics(); }
    catch (e) { logWarning("bootstrap", "failed to start proactive diagnostics", { err: e instanceof Error ? e.message : String(e) }); }

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

// =============================================================================
// A2A bootstrap — wired non-fatally from bootstrap(). Runs the tunnel manager
// (cloudflared / external / disabled), starts the HTTP server on an
// auto-allocated port, registers the singleton handle, and subscribes to
// tunnel URL changes to fire the address-update broadcaster.
// =============================================================================

async function startA2A(botName: string): Promise<void> {
    const vault = getVault();
    const mode = ((vault.get("A2A_TUNNEL_MODE") ?? "cloudflared") as TunnelMode);
    if (mode === "disabled") {
        console.log("🛰  A2A: disabled via vault A2A_TUNNEL_MODE=disabled");
        return;
    }

    const externalUrl = vault.get("A2A_BASE_URL");
    if (mode === "external" && !externalUrl) {
        console.warn("🛰  A2A: mode=external but A2A_BASE_URL not set in vault — server will start without a public URL");
    }

    // OUR API key — what every peer must present when calling us. Generated
    // on first boot, never rotated automatically.
    let apiKey = vault.get("A2A_API_KEY");
    if (!apiKey) {
        apiKey = randomBytes(32).toString("hex");
        vault.set("A2A_API_KEY", apiKey);
        console.log("🛰  A2A: generated new A2A_API_KEY (stored in vault)");
    }

    const preferredPort = parseInt(vault.get("A2A_BIND_PORT") ?? "8085", 10) || 8085;
    const bindHost = vault.get("A2A_BIND_HOST") ?? "127.0.0.1";

    // Optional operator overrides for the agent card.
    const description = vault.get("A2A_DESCRIPTION") ?? `${botName} — ori2 agent`;
    const additionalSkillsJson = vault.get("A2A_SKILLS_JSON");
    let additionalSkills: Array<{ id: string; name: string; description: string; tags: string[] }> | undefined;
    if (additionalSkillsJson) {
        try {
            const raw = JSON.parse(additionalSkillsJson) as Array<{
                id?: unknown; name?: unknown; description?: unknown; tags?: unknown;
            }>;
            additionalSkills = raw
                .filter((s) => typeof s.id === "string" && typeof s.name === "string" && typeof s.description === "string")
                .map((s) => ({
                    id: s.id as string,
                    name: s.name as string,
                    description: s.description as string,
                    tags: Array.isArray(s.tags) ? (s.tags as unknown[]).filter((t): t is string => typeof t === "string") : [],
                }));
        }
        catch (e) { console.warn(`🛰  A2A: A2A_SKILLS_JSON invalid: ${e instanceof Error ? e.message : String(e)}`); }
    }

    // Phase 1: server starts FIRST so the bound port is known. Then we kick
    // the tunnel which forwards to that port. Card initially has whatever
    // baseUrl we know now (operator-supplied or empty); we refreshAgentCard
    // once the tunnel discovers the real URL.
    let initialBaseUrl = externalUrl ?? "";

    let handle: A2AServerHandle;
    try {
        handle = await startA2AServer({
            botName,
            agentId: vault.get("A2A_AGENT_ID") ?? `ori2-${botName.toLowerCase()}`,
            description,
            baseUrl: initialBaseUrl,
            apiKey,
            host: bindHost,
            preferredPort,
            ...(vault.get("A2A_PROVIDER_NAME") !== undefined ? { providerName: vault.get("A2A_PROVIDER_NAME")! } : {}),
            ...(vault.get("A2A_PROVIDER_URL") !== undefined ? { providerUrl: vault.get("A2A_PROVIDER_URL")! } : {}),
            ...(additionalSkills !== undefined ? { additionalSkills } : {}),
        });
    } catch (e) {
        getA2AAdapter().markError(e instanceof Error ? e.message : String(e));
        throw e;
    }
    setA2AServerHandle(handle);
    // Persist the actually-bound port so the next boot prefers it (sticky).
    vault.set("A2A_BIND_PORT", String(handle.boundPort));
    console.log(`🛰  A2A: server bound on ${bindHost}:${handle.boundPort}`);

    // Tunnel.
    const tunnel = new TunnelManager({
        mode,
        localPort: handle.boundPort,
        ...(externalUrl !== undefined ? { externalUrl } : {}),
    });
    tunnel.on("url-ready", (url: string) => {
        vault.set("A2A_BASE_URL", url);
        handle.refreshAgentCard({ baseUrl: url });
        getA2AAdapter().markRunning(handle.boundPort, url);
        initialBaseUrl = url;
        console.log(`🛰  A2A: tunnel URL ready → ${url}`);
        // First broadcast — friends learn our URL.
        void broadcastAddressUpdate({ senderName: botName, newBaseUrl: url }).then((report) => {
            if (report.succeeded.length || report.failed.length) {
                console.log(
                    `🛰  A2A: address broadcast: ${report.succeeded.length} ok, ${report.failed.length} failed, ${report.skippedNoKey.length} no-key`,
                );
            }
        });
    });
    tunnel.on("url-changed", (url: string) => {
        vault.set("A2A_BASE_URL", url);
        handle.refreshAgentCard({ baseUrl: url });
        getA2AAdapter().markRunning(handle.boundPort, url);
        console.log(`🛰  A2A: tunnel URL changed → ${url}`);
        void broadcastAddressUpdate({ senderName: botName, newBaseUrl: url });
    });
    tunnel.on("error", (e: Error) => {
        logWarning("a2a-tunnel", e.message);
    });

    // Process shutdown — stop the tunnel and the server before the dispatcher.
    const stopA2A = async () => {
        try { await tunnel.stop(); } catch { /* ignore */ }
        try { await handle.stop(); } catch { /* ignore */ }
        setA2AServerHandle(null);
    };
    process.once("SIGINT", () => { void stopA2A(); });
    process.once("SIGTERM", () => { void stopA2A(); });
    process.once("SIGHUP", () => { void stopA2A(); });

    // Kick the tunnel — don't await indefinitely. start() resolves when the
    // first URL is detected (or the timeout fires); url-ready handler does
    // the rest.
    void tunnel.start();
}

bootstrap().catch(console.error);
