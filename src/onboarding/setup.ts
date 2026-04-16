import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { getVault, Vault } from "../core/vault.js";

// =============================================================================
// First-run onboarding wizard.
//
// Two-store split:
//   - VAULT (data/<BOT>/vault.json, mode 0600) — secrets:
//       ADMIN_USER_IDS, ANTHROPIC_API_KEY, GOOGLE_API_KEY, OPENAI_API_KEY
//   - .env (project root) — non-secret runtime config:
//       BOT_NAME, PRIMARY_PROVIDER, REQUIRE_2FA, GUARDRAIL_EMBEDDINGS
//
// Why split: BOT_NAME is needed BEFORE the vault loads (it determines the
// vault's path: data/<BOT_NAME>/vault.json). Other .env entries are flags or
// UI hints that don't need protecting.
//
// "System configured" = vault file exists. The wizard runs iff vault is missing.
// =============================================================================

const ENV_PATH = path.resolve(process.cwd(), ".env");

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

    let googleKey = "";
    let anthropicKey = "";
    let openaiKey = "";
    let primaryProvider: "gemini" | "anthropic" | "openai" = "gemini";

    if (providerChoice === "2") {
        primaryProvider = "anthropic";
        anthropicKey = (await rl.question("\n   🔑 Enter your Anthropic API Key: ")).trim();
        console.log("\n   ℹ️  Your prompt-injection guardrail uses LOCAL embeddings (BGE-small) by default — no extra API key needed.");
        console.log("       You can switch to Google/OpenAI embeddings later by adding their keys via the wizard or vault tools.");
    } else if (providerChoice === "3") {
        primaryProvider = "openai";
        openaiKey = (await rl.question("\n   🔑 Enter your OpenAI API Key: ")).trim();
    } else {
        primaryProvider = "gemini";
        googleKey = (await rl.question("\n   🔑 Enter your Google Gemini API Key: ")).trim();
    }

    rl.close();

    // Write secrets to vault — atomic, mode 0600.
    const vault = getVault();
    const secrets: Record<string, string> = {};
    if (adminIds) secrets["ADMIN_USER_IDS"] = adminIds;
    if (googleKey) secrets["GOOGLE_API_KEY"] = googleKey;
    if (anthropicKey) secrets["ANTHROPIC_API_KEY"] = anthropicKey;
    if (openaiKey) secrets["OPENAI_API_KEY"] = openaiKey;
    // BOT_NAME has to be in env BEFORE vault is consulted (vault path depends
    // on it), so we set it temporarily so botSubdir() in vault.set works.
    process.env["BOT_NAME"] = safeBotName;
    vault.bulkSet(secrets);

    // Non-secret runtime config goes to .env so it's loaded by dotenv on next boot.
    writeEnv({
        BOT_NAME: safeBotName,
        PRIMARY_PROVIDER: primaryProvider,
        REQUIRE_2FA: "true",
    });

    console.log("\n================================================");
    console.log("✅ Setup Complete!");
    console.log(`   Vault: ${Vault.path()}`);
    console.log(`   Runtime config: ${ENV_PATH}`);
    console.log("================================================\n");
}
