import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { getVault, Vault } from "../core/vault.js";
import { botSubdir, ensureDir } from "../core/paths.js";

// =============================================================================
// First-run onboarding wizard.
//
// Three-store split:
//   - VAULT (data/<BOT>/vault.json, mode 0600) — our own secret store:
//       ADMIN_USER_IDS, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY,
//       TELEGRAM_BOT_TOKEN, A2A_API_KEY, INIT_PASSCODE, etc.
//       The *_API_KEY entries mirror what we write to Pi's auth.json so a
//       future bot evolution can read them without parsing Pi's state.
//   - PI AUTH (data/<BOT>/.pi-state/auth.json, mode 0600) — Pi-native LLM
//       credential store. Resolution priority for Pi: --api-key flag >
//       auth.json > env vars > models.json (see pi-coding-agent/docs/providers.md
//       §Resolution Order). Writing here is the correct path — env-var
//       hydration is a belt-and-braces fallback.
//   - PI SETTINGS (data/<BOT>/.pi-state/settings.json) — Pi-native
//       configuration: defaultProvider, defaultModel, compaction, theme, etc.
//       (see pi-coding-agent/docs/settings.md).
//   - .env (project root) — non-secret runtime config only:
//       BOT_NAME (needed to locate vault), GUARDRAIL_EMBEDDINGS.
//       NOTE: PRIMARY_PROVIDER was previously written here but no Pi
//       component reads it; Pi reads defaultProvider from settings.json.
//       NOTE: REQUIRE_2FA was previously written here but no code path
//       reads it; 2FA is configured per-tool in core/policy.ts instead.
//
// Why split: BOT_NAME is needed BEFORE the vault loads (it determines the
// vault's path: data/<BOT_NAME>/vault.json). Pi-native files need the
// per-bot .pi-state dir which is set via PI_CODING_AGENT_DIR at boot.
//
// "System configured" = vault file exists. The wizard runs iff vault is missing.
// =============================================================================

const ENV_PATH = path.resolve(process.cwd(), ".env");

/** Pi's per-bot config dir, same as src/index.ts PI_CODING_AGENT_DIR. */
function piStateDir(): string {
    return botSubdir(".pi-state");
}

/**
 * Pi-native auth file. Shape per pi-coding-agent/docs/providers.md §Auth File:
 *   { "<provider>": { "type": "api_key", "key": "..." } }
 * Pi reads this at model-resolution time and it takes priority over env vars.
 * Created mode 0600 (docs say Pi does the same on its /login flow).
 */
function writePiAuthJson(entries: Record<string, string>): void {
    const dir = piStateDir();
    ensureDir(dir);
    const file = path.join(dir, "auth.json");
    // Merge with any existing auth.json (e.g. user ran /login previously).
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
        try { existing = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>; }
        catch { /* treat as empty — malformed will be overwritten */ }
    }
    for (const [provider, key] of Object.entries(entries)) {
        if (!key) continue;
        existing[provider] = { type: "api_key", key };
    }
    // Atomic write with 0600 — matches Pi's own /login implementation.
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
        fs.writeSync(fd, JSON.stringify(existing, null, 2));
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
}

/**
 * Pi-native settings file. Keys documented in
 * pi-coding-agent/docs/settings.md — we only set defaultProvider + optionally
 * defaultModel at wizard time; operator can `/settings` to tune the rest.
 */
function writePiSettingsJson(updates: { defaultProvider?: string; defaultModel?: string }): void {
    const dir = piStateDir();
    ensureDir(dir);
    const file = path.join(dir, "settings.json");
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
        try { existing = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>; }
        catch { /* fine, overwrite */ }
    }
    if (updates.defaultProvider) existing["defaultProvider"] = updates.defaultProvider;
    if (updates.defaultModel) existing["defaultModel"] = updates.defaultModel;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
    fs.renameSync(tmp, file);
}

export function isSystemConfigured(): boolean {
    // Vault on disk is the authoritative signal — without it, the bot has no
    // credentials and onboarding must run regardless of what's in .env.
    return Vault.fileExists();
}

function writeEnv(entries: Record<string, string>): void {
    // Preserve any existing .env we don't manage (e.g., user-added overrides).
    const existing: Record<string, string> = {};
    if (fs.existsSync(ENV_PATH)) {
        for (const line of fs.readFileSync(ENV_PATH, "utf-8").split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const eq = trimmed.indexOf("=");
            if (eq <= 0) continue;
            existing[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
        }
    }
    const merged = { ...existing, ...entries };
    const lines = [
        "# Ori2 runtime config — non-secret only.",
        "# Secrets (admin IDs, API keys) live in data/<BOT_NAME>/vault.json instead.",
        "",
    ];
    for (const [k, v] of Object.entries(merged)) lines.push(`${k}=${v}`);
    fs.writeFileSync(ENV_PATH, `${lines.join("\n")}\n`);
}

export async function runOnboardingFlow(): Promise<void> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    console.log("\n================================================");
    console.log("🚀 Welcome to the Ori Platform Setup Wizard 🚀");
    console.log("================================================\n");
    console.log("It looks like this is your first time starting up.");
    console.log("Let's get your assistant configured in just 3 steps.\n");

    const botNameRaw = await rl.question("1. What would you like to name this assistant? (e.g. MarketingBot): ");
    const safeBotName = botNameRaw.trim().replace(/[^a-zA-Z0-9_-]/g, "_") || "Platform_Controller";

    console.log("\n2. ADMIN identity for chat platforms");
    console.log("");
    console.log("   The terminal operator (you, right now) is ALWAYS admin —");
    console.log("   you own the process and the vault, no setup needed for CLI access.");
    console.log("");
    console.log("   For chat platforms (Telegram/Slack/etc.), the recommended path is");
    console.log("   to claim admin AFTER install via `/init <passcode>` from chat. The");
    console.log("   passcode is shown ONCE in this boot's log, your chat ID is captured");
    console.log("   automatically, and the passcode is consumed on first successful claim.");
    console.log("");
    console.log("   You can ALSO pre-register chat IDs here in <platform>:<id> format,");
    console.log("   comma-separated. Examples:");
    console.log("     telegram:123456789");
    console.log("     telegram:123456789,slack:U0ABC123XYZ");
    console.log("   (Telegram numeric ID: message @userinfobot. Slack: profile → More → Copy member ID.)");
    console.log("");
    console.log("   Press ENTER to skip — you'll claim admin via /init from chat after install.");
    const adminIds = (await rl.question("   Pre-registered admin IDs (or ENTER to skip): ")).trim();

    console.log("\n3. Choose your primary AI brain. (You can add others later)");
    console.log("   [1] Google Gemini  (Recommended for embeddings)");
    console.log("   [2] Anthropic Claude");
    console.log("   [3] OpenAI GPT-4");
    const providerChoice = (await rl.question("   Select an option (1-3): ")).trim();

    // Map our user-facing choice (1/2/3) to:
    //   - Pi's provider name (what goes in auth.json and settings.json)
    //   - vault key name (Pi SDK env-var convention per
    //     @mariozechner/pi-ai/dist/env-api-keys.js: google → GEMINI_API_KEY)
    //   - the human label shown during the prompt
    let piProvider: "google" | "anthropic" | "openai" = "google";
    let vaultKey: "GEMINI_API_KEY" | "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" = "GEMINI_API_KEY";
    let apiKey = "";

    if (providerChoice === "2") {
        piProvider = "anthropic";
        vaultKey = "ANTHROPIC_API_KEY";
        apiKey = (await rl.question("\n   🔑 Enter your Anthropic API Key: ")).trim();
        console.log("\n   ℹ️  Your prompt-injection guardrail uses LOCAL embeddings (BGE-small) by default — no extra API key needed.");
        console.log("       You can switch to Google/OpenAI embeddings later by adding their keys via the wizard or vault tools.");
    } else if (providerChoice === "3") {
        piProvider = "openai";
        vaultKey = "OPENAI_API_KEY";
        apiKey = (await rl.question("\n   🔑 Enter your OpenAI API Key: ")).trim();
    } else {
        piProvider = "google";
        vaultKey = "GEMINI_API_KEY";
        apiKey = (await rl.question("\n   🔑 Enter your Google Gemini API Key: ")).trim();
    }

    rl.close();

    // BOT_NAME has to be in env BEFORE vault is consulted (vault path depends
    // on it), AND before piStateDir() resolves.
    process.env["BOT_NAME"] = safeBotName;

    // Write our own secret store (vault) — admin IDs + the API key under its
    // Pi-canonical name so future reads (rotation, migration, inspection) use
    // the same name Pi itself uses.
    const vault = getVault();
    const secrets: Record<string, string> = {};
    if (adminIds) secrets["ADMIN_USER_IDS"] = adminIds;
    if (apiKey) secrets[vaultKey] = apiKey;
    vault.bulkSet(secrets);

    // Write Pi's native auth.json — this is what Pi's ModelRegistry reads
    // first (priority: --api-key flag > auth.json > env vars). Without this
    // the wizard leaves Pi with no credentials and the TUI fails with
    // "No API key found for unknown" on first message.
    if (apiKey) {
        writePiAuthJson({ [piProvider]: apiKey });
    }

    // Write Pi's settings.json — defaultProvider tells Pi which provider to
    // pick a model from on boot. Without this Pi has no default and fails
    // model resolution. See pi-coding-agent/docs/settings.md §Model & Thinking.
    writePiSettingsJson({ defaultProvider: piProvider });

    // Non-secret runtime config. BOT_NAME is needed to locate the vault on
    // next boot (before .env is loaded). PRIMARY_PROVIDER is deliberately
    // NOT written — no Pi component reads it; settings.json.defaultProvider
    // is the source of truth.
    writeEnv({
        BOT_NAME: safeBotName,
    });

    console.log("\n================================================");
    console.log("✅ Setup Complete!");
    console.log(`   Vault:          ${Vault.path()}`);
    console.log(`   Pi auth:        ${path.join(piStateDir(), "auth.json")}`);
    console.log(`   Pi settings:    ${path.join(piStateDir(), "settings.json")}`);
    console.log(`   Runtime config: ${ENV_PATH}`);
    console.log("================================================\n");
}
