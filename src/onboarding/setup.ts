import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { getVault, Vault } from "../core/vault.js";
import { botSubdir, ensureDir, secretSubdir, ensureSecretDir } from "../core/paths.js";
import { ensureInitPasscode } from "../core/passcode.js";

// ---- tiny ANSI helpers (no-color safe) ----------------------------------
const USE_COLOR = process.stdout.isTTY && !process.env["NO_COLOR"];
const C = {
    reset:   USE_COLOR ? "\x1b[0m"  : "",
    bold:    USE_COLOR ? "\x1b[1m"  : "",
    dim:     USE_COLOR ? "\x1b[2m"  : "",
    red:     USE_COLOR ? "\x1b[31m" : "",
    green:   USE_COLOR ? "\x1b[32m" : "",
    yellow:  USE_COLOR ? "\x1b[33m" : "",
    blue:    USE_COLOR ? "\x1b[34m" : "",
    magenta: USE_COLOR ? "\x1b[35m" : "",
    cyan:    USE_COLOR ? "\x1b[36m" : "",
};
function banner(): void {
    console.log("");
    console.log(`${C.cyan}   ___  ____  ___ ___  ${C.reset}`);
    console.log(`${C.cyan}  / _ \\|  _ \\|_ _|__ \\ ${C.reset}`);
    console.log(`${C.cyan} | | | | |_) || |  / / ${C.reset}`);
    console.log(`${C.cyan} | |_| |  _ < | | / /_ ${C.reset}`);
    console.log(`${C.cyan}  \\___/|_| \\_\\___|____|${C.reset}`);
    console.log(`${C.dim}  your local AI assistant${C.reset}`);
    console.log("");
}

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

    banner();
    console.log(`${C.bold}Welcome — let's set up your assistant.${C.reset}`);
    console.log(`${C.dim}Three quick questions. Takes under a minute.${C.reset}\n`);

    // --- 1. Name ---
    // Pre-set by bootstrap.sh via .env so the user isn't asked twice. If an
    // explicit BOT_NAME is already in env (non-empty, not the default
    // placeholder), reuse it and skip the prompt.
    const envBotName = (process.env["BOT_NAME"] ?? "").trim();
    let safeBotName: string;
    if (envBotName && envBotName !== "ori2_agent") {
        safeBotName = envBotName.replace(/[^a-zA-Z0-9_-]/g, "_");
        console.log(`${C.bold}${C.cyan}1️⃣  NAME${C.reset}   ${C.green}✔${C.reset} ${C.bold}${safeBotName}${C.reset} ${C.dim}(from .env)${C.reset}`);
    } else {
        console.log(`${C.bold}${C.cyan}1️⃣  NAME YOUR ASSISTANT${C.reset}`);
        console.log(`${C.dim}   Short nickname — letters, numbers, underscores only.${C.reset}`);
        console.log(`${C.dim}   Examples: MarketingBot, amazon_helper, ClaireBot${C.reset}\n`);
        const botNameRaw = await rl.question(`   ${C.yellow}Name:${C.reset} `);
        safeBotName = botNameRaw.trim().replace(/[^a-zA-Z0-9_-]/g, "_") || "Platform_Controller";
        if (safeBotName !== botNameRaw.trim()) {
            console.log(`   ${C.dim}(cleaned to: ${safeBotName})${C.reset}`);
        }
    }

    // --- 2. Admin access (chat-side) ---
    console.log(`\n${C.bold}${C.cyan}2️⃣  WHO IS THE ADMIN?${C.reset}`);
    console.log(`${C.dim}   You, running this wizard, are ALREADY admin — nothing to do${C.reset}`);
    console.log(`${C.dim}   for terminal access. For chat platforms (Telegram etc.) just${C.reset}`);
    console.log(`${C.dim}   press ENTER — after install the bot prints a one-time passcode${C.reset}`);
    console.log(`${C.dim}   you'll send to it via chat (like: /init abc123xyz).${C.reset}`);
    console.log(`${C.dim}   (Advanced: paste IDs like telegram:123456789 or slack:U0ABC123.)${C.reset}`);
    const adminIds = (await rl.question(`   ${C.yellow}Admin chat IDs (ENTER to skip):${C.reset} `)).trim();

    // --- 3. AI provider ---
    console.log(`\n${C.bold}${C.cyan}3️⃣  PICK AN AI BRAIN${C.reset}`);
    console.log(`${C.dim}   Your assistant needs an AI provider key. You can change this later.${C.reset}\n`);
    console.log(`   ${C.bold}[1]${C.reset} Google Gemini    ${C.dim}→${C.reset} ${C.blue}https://aistudio.google.com/apikey${C.reset}`);
    console.log(`   ${C.bold}[2]${C.reset} Anthropic Claude ${C.dim}→${C.reset} ${C.blue}https://console.anthropic.com/settings/keys${C.reset}`);
    console.log(`   ${C.bold}[3]${C.reset} OpenAI (GPT)     ${C.dim}→${C.reset} ${C.blue}https://platform.openai.com/api-keys${C.reset}\n`);
    console.log(`${C.dim}   Don't have any? → [1] Gemini has a free tier — quickest signup.${C.reset}`);
    const providerChoice = (await rl.question(`   ${C.yellow}Your pick (1/2/3):${C.reset} `)).trim();

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
        console.log(`\n   ${C.dim}Paste your ${chosen.label} API key (get one at ${C.blue}${chosen.url}${C.reset}${C.dim}):${C.reset}`);
        console.log(`   ${C.dim}Or type ${C.reset}${C.bold}SKIP${C.reset} ${C.dim}to set it up later via /credentials or /oauth.${C.reset}`);
        const raw = (await rl.question(`   ${C.yellow}Key:${C.reset} `)).trim();
        if (raw.toUpperCase() === "SKIP") {
            console.log(`   ${C.yellow}!${C.reset} Skipping — you'll need to set a key before the bot can reply.`);
            break;
        }
        if (raw.length < 20) {
            console.log(`   ${C.red}✖${C.reset} That doesn't look like a valid API key (too short: ${raw.length} chars).`);
            console.log(`     ${C.dim}Real keys are long strings from ${chosen.url}. Try again or SKIP.${C.reset}`);
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

    // Generate the init passcode HERE (not on first bot boot) so we can:
    //   1. surface it prominently in the post-install panel (bootstrap.sh
    //      reads the recovery file below to embed it)
    //   2. write a recovery file the operator can `cat` later if they miss
    //      the boot log
    // Both points address the recurring "I never saw the passcode" UX bug.
    const passcode = ensureInitPasscode();
    if (passcode) {
        const recoveryFile = path.join(secretSubdir(), "INIT_PASSCODE.txt");
        ensureSecretDir(secretSubdir());
        const fd = fs.openSync(recoveryFile, "w", 0o600);
        try {
            fs.writeSync(fd, [
                "ORI2 INIT PASSCODE — one-time admin-claim token",
                "",
                `Passcode:  ${passcode}`,
                "",
                "Use:",
                "  • From CLI: /init " + passcode,
                "  • From Telegram (after /connect-telegram): DM bot \"/init " + passcode + "\"",
                "",
                "This file is auto-deleted when /init succeeds. If the file is gone,",
                "the passcode has already been consumed and admin has been claimed.",
                "",
                "If lost AND not yet consumed: run /init-status at the bot TUI to re-display.",
                "",
            ].join("\n"));
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
    }

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

    console.log(`\n${C.green}╔══════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.green}║${C.reset} ${C.bold}✔ Setup complete.${C.reset}                        ${C.green}║${C.reset}`);
    console.log(`${C.green}╚══════════════════════════════════════════╝${C.reset}`);
    console.log(`  ${C.dim}Vault:${C.reset}          ${Vault.path()}`);
    console.log(`  ${C.dim}Pi auth:${C.reset}        ${path.join(piStateDir(), "auth.json")}`);
    console.log(`  ${C.dim}Pi settings:${C.reset}    ${path.join(piStateDir(), "settings.json")}`);
    console.log(`  ${C.dim}Runtime config:${C.reset} ${ENV_PATH}\n`);

    // Loud passcode banner — uses simple horizontal rules instead of a box,
    // because boxed layouts that include ANSI colour escapes break alignment
    // (escape sequences count as bytes but render as zero columns, so the
    // right border drifts).  bootstrap.sh ALSO reads the recovery file and
    // re-displays the passcode in the post-install panel for a second chance
    // to see it.
    if (passcode) {
        const recoveryFile = path.join(secretSubdir(), "INIT_PASSCODE.txt");
        const rule = "━".repeat(60);
        console.log("");
        console.log(`${C.yellow}${C.bold}${rule}${C.reset}`);
        console.log(`  ${C.bold}${C.yellow}🔑  ADMIN PASSCODE — copy this NOW${C.reset}`);
        console.log("");
        console.log(`      ${C.bold}${C.green}${passcode}${C.reset}`);
        console.log("");
        console.log(`  After bot starts, DM it from Telegram and reply:`);
        console.log(`      ${C.cyan}/init ${passcode}${C.reset}`);
        console.log("");
        console.log(`  ${C.dim}Backup file (auto-deleted on first /init):${C.reset}`);
        console.log(`  ${C.dim}${recoveryFile}${C.reset}`);
        console.log(`${C.yellow}${C.bold}${rule}${C.reset}`);
        console.log("");
    }
}
