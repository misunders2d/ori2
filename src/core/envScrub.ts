// =============================================================================
// envScrub — delete credential-bearing env vars from process.env. Called once
// at boot from src/index.ts BEFORE any extension or tool can run.
//
// Both vault-mirrored values AND any operator-shell-exported credentials
// (GITHUB_TOKEN, AWS_*, etc.) are deleted. The vault remains the only store
// of record; code that needs a value calls getVault().get(name).
//
// Defense purpose: makes `bash 'env'` from the LLM return zero secrets.
// secret_files_guard blocks reads of vault.json directly; this closes the
// `bash 'echo $GEMINI_API_KEY'` and `bash 'env | grep KEY'` complementary
// path.
// =============================================================================

// Substring/suffix patterns matched against env-var NAMES (case-insensitive).
// Anything matching → deleted unless in SCRUB_KEEPLIST.
export const CREDENTIAL_ENV_PATTERN = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSCODE|^ADMIN_USER_IDS$|_CREDENTIALS$|^GH_TOKEN$|^NPM_TOKEN$)/i;

/** Env vars that LOOK credential-bearing by pattern but are actually
 *  load-bearing infra config to keep at runtime. Add cautiously and
 *  document why each entry exists. */
export const SCRUB_KEEPLIST = new Set<string>([
    // (none currently — keeplist exists so future maintainers know the
    // protocol if they need to except a key, e.g., a non-secret config var
    // that happens to match the pattern)
]);

export function scrubCredentialEnvVars(env: NodeJS.ProcessEnv = process.env): { scrubbed: string[] } {
    const scrubbed: string[] = [];
    for (const key of Object.keys(env)) {
        if (SCRUB_KEEPLIST.has(key)) continue;
        if (CREDENTIAL_ENV_PATTERN.test(key)) {
            delete env[key];
            scrubbed.push(key);
        }
    }
    return { scrubbed };
}
