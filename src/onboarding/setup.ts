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
    console.log("🚀 Welcome — let's set up your assistant 🚀");
    console.log("================================================\n");
    console.log("This wizard asks 3 questions. Takes about a minute.\n");

    // --- 1. Name ---
    console.log("1️⃣  NAME YOUR ASSISTANT");
    console.log("   A short nickname, letters/numbers/underscores only.");
    console.log("   Examples: MarketingBot, amazon_helper, ClaireBot\n");
    const botNameRaw = await rl.question("   Name: ");
    const safeBotName = botNameRaw.trim().replace(/[^a-zA-Z0-9_-]/g, "_") || "Platform_Controller";
    if (safeBotName !== botNameRaw.trim()) {
        console.log(`   (cleaned to: ${safeBotName})`);
    }

    // --- 2. Admin access (chat-side) ---
    console.log("\n2️⃣  WHO IS THE ADMIN?");
    console.log("   You (running this wizard in the terminal) are ALREADY admin — nothing");
    console.log("   to do for terminal access.\n");
    console.log("   For chat platforms (Telegram etc.), just press ENTER below. After");
    console.log("   install the bot prints a one-time passcode — you'll send it to the");
    console.log("   bot from your chat app (like: /init abc123xyz) and you become admin.\n");
    console.log("   (Advanced: if you already know your chat IDs, paste them as");
    console.log("    telegram:123456789 or slack:U0ABC123 — otherwise ENTER to skip.)");
    const adminIds = (await rl.question("   Admin chat IDs (ENTER to skip): ")).trim();

    // --- 3. AI provider ---
    console.log("\n3️⃣  PICK AN AI BRAIN");
    console.log("   Your assistant needs an AI provider key. You can change this later.");
    console.log("   Pick ONE — whichever you already have an account with.\n");
    console.log("   [1] Google Gemini   → get a key at https://aistudio.google.com/apikey");
    console.log("   [2] Anthropic Claude → get a key at https://console.anthropic.com/settings/keys");
    console.log("   [3] OpenAI (GPT)    → get a key at https://platform.openai.com/api-keys\n");
    console.log("   Don't have any? → [1] Gemini has a free tier, quickest to sign up.\n");
    const providerChoice = (await rl.question("   Your pick (1/2/3): ")).trim();

    // Map choice → (Pi provider name, vault key name per Pi SDK convention,
    // human-readable provider label for the API key prompt).
    const providerMap = {
        "1": { pi: "google" as const,    vaultKey: "GEMINI_API_KEY" as const,    label: "Google Gemini",   url: "https://aistudio.google.com/apikey" },
        "2": { pi: "anthropic" as const, vaultKey: "ANTHROPIC_API_KEY" as const, label: "Anthropic Claude", url: "https://console.anthropic.com/settings/keys" },
        "3": { pi: "openai" as const,    vaultKey: "OPENAI_API_KEY" as const,    label: "OpenAI",           url: "https://platform.openai.com/api-keys" },
    };
    const chosen = providerMap[providerChoice as "1" | "2" | "3"] ?? providerMap["1"];
    const piProvider: "google" | "anthropic" | "openai" = chosen.pi;
    const vaultKey: "GEMINI_API_KEY" | "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" = chosen.vaultKey;
    if (!providerMap[providerChoice as "1" | "2" | "3"]) {
        console.log(`   (didn't recognize "${providerChoice}" — defaulting to Google Gemini)`);
    }

    // Loop until we get a plausible key, OR the user explicitly skips.
    // Minimum length 20 is a sanity check — real keys are 40-200 chars
    // depending on provider; anything under 20 is almost certainly a typo.
    let apiKey = "";
    while (true) {
        console.log(`\n   Paste your ${chosen.label} API key (get one at ${chosen.url}):`);
        console.log(`   Or type SKIP to set it up later via /credentials or /oauth.`);
        const raw = (await rl.question("   Key: ")).trim();
        if (raw.toUpperCase() === "SKIP") {
            console.log("   ⚠️  Skipping — you'll need to set a key before the bot can reply.");
            break;
        }
        if (raw.length < 20) {
            console.log(`   ❌ That doesn't look like a valid API key (too short: ${raw.length} chars).`);
            console.log(`      Real keys are long strings from ${chosen.url}. Try again or type SKIP.`);
            continue;
        }
        apiKey = raw;
        break;
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
