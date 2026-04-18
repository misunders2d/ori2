import fs from "node:fs";
import path from "node:path";
import { botDir, secretSubdir, ensureSecretDir } from "./paths.js";

// =============================================================================
// One-shot migration: relocate credential-bearing files from
//   data/<bot>/{vault,credentials,oauth_*}.json + pending_actions.db
// to
//   data/<bot>/.secret/<same filename>
//
// Why moved: the LLM has Pi's built-in read/edit/bash/grep/write/glob tools.
// Mode 0600 stops other OS users; it does NOT stop the bot's own LLM from
// inspecting these files via those tools. Clustering everything under
// `.secret/` lets `secret_files_guard` deny all of `data/<bot>/` with a
// single rule and lets the operator `chmod 700` the whole cluster.
//
// Run on every boot — does nothing once migration is complete (idempotent).
// Failures are logged and re-thrown: an aborted partial migration that
// leaves a half-state vault is worse than a refusal-to-boot loud error
// the operator can see and fix manually.
// =============================================================================

const LEGACY_FILES = [
    "vault.json",
    "credentials.json",
    "oauth_platforms.json",
    "oauth_tokens.json",
    "pending_actions.db",
];

export interface MigrationResult {
    moved: string[];
    skipped_already_at_target: string[];
    skipped_no_legacy: string[];
}

export function migrateSecretFilesLocation(): MigrationResult {
    const result: MigrationResult = {
        moved: [],
        skipped_already_at_target: [],
        skipped_no_legacy: [],
    };

    // Cheap fast-path: if the .secret/ dir already contains everything, we
    // can return without even probing the legacy locations. The first move
    // creates the dir, so its absence implies nothing has migrated yet.
    const secretDir = secretSubdir();
    ensureSecretDir(secretDir);

    for (const name of LEGACY_FILES) {
        const legacyPath = path.join(botDir(), name);
        const targetPath = path.join(secretDir, name);
        const targetExists = fs.existsSync(targetPath);
        const legacyExists = fs.existsSync(legacyPath);

        if (targetExists && !legacyExists) {
            result.skipped_already_at_target.push(name);
            continue;
        }
        if (!legacyExists) {
            result.skipped_no_legacy.push(name);
            continue;
        }
        if (targetExists && legacyExists) {
            // Both exist — refuse to clobber. This is the operator-must-decide
            // scenario: a half-migrated install or someone hand-restored a
            // backup. Loud error.
            throw new Error(
                `[secretMigration] FATAL: both ${legacyPath} AND ${targetPath} exist. ` +
                `Inspect both, decide which is canonical, remove the other, then re-boot.`,
            );
        }
        // Only legacy exists — move it. Use rename for atomicity (POSIX
        // guarantee within the same filesystem; data/<bot>/ and
        // data/<bot>/.secret/ are always on the same FS).
        fs.renameSync(legacyPath, targetPath);
        // Also try to relocate the sqlite WAL/SHM siblings if present —
        // better-sqlite3 leaves <db>.db-wal and <db>.db-shm next to the
        // main file when journal_mode = WAL.
        if (name.endsWith(".db")) {
            for (const sfx of ["-wal", "-shm"]) {
                const legacySidecar = legacyPath + sfx;
                if (fs.existsSync(legacySidecar)) {
                    fs.renameSync(legacySidecar, targetPath + sfx);
                }
            }
        }
        result.moved.push(name);
    }

    return result;
}
