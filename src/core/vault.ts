import fs from "node:fs";
import path from "node:path";
import { secretSubdir, ensureSecretDir } from "./paths.js";

// =============================================================================
// Vault — per-bot encrypted-at-rest-permission, plain-text-on-disk credential
// store. Replaces ad-hoc `.env` storage of secrets.
//
// Design:
//   - File: `data/<BOT>/.secret/vault.json`, mode 0600 (owner read/write only).
//     Lives under `.secret/` so the secret_files_guard extension can deny
//     LLM file-tool access by single prefix.
//   - Format: { version, created_at, updated_at, data: { key: value } }.
//   - Atomic writes: write to vault.json.tmp + rename (atomic on POSIX).
//   - Singleton: getVault() lazy-loads on first call, cached process-wide.
//   - Fail-loud: corrupt or unreadable vault throws — never silently empty.
//
// What goes here:
//   - All secrets: API keys, OAuth tokens, webhook secrets, refresh tokens.
//   - Sensitive identity: ADMIN_USER_IDS, allowlists when sensitive.
//   - Future: TOTP seeds, encrypted-at-rest field for very-high-sensitivity.
//
// What does NOT go here:
//   - Runtime config: BOT_NAME, GUARDRAIL_EMBEDDINGS backend selector.
//     Those stay in `.env` because they're needed before vault loads
//     and aren't sensitive.
//
// SECURITY NOTES:
//   - Values are cached in process memory after first read. Acceptable because
//     the Pi process is the trust boundary — anyone who can read process memory
//     can already read the vault file directly.
//   - `list()` returns KEYS ONLY. Never log values.
//   - File permission is set on every write. If the file already exists with
//     a more permissive mode (e.g. someone copied it), the next write fixes it.
//   - The vault directory is `data/<BOT>/` which is gitignored repo-wide.
//   - Disk-encryption-at-rest is the user's responsibility (LUKS/FileVault/etc).
// =============================================================================

const VAULT_VERSION = 1;

interface VaultFile {
    version: number;
    created_at: number;
    updated_at: number;
    data: Record<string, string>;
}

function vaultPath(): string {
    return path.join(secretSubdir(), "vault.json");
}

function tempPath(): string {
    return vaultPath() + ".tmp";
}

class Vault {
    private state: VaultFile | null = null;

    private load(): VaultFile {
        if (this.state) return this.state;
        const file = vaultPath();
        if (!fs.existsSync(file)) {
            // Fresh vault — create empty in memory only. Caller (onboarding)
            // will populate and call save().
            const now = Date.now();
            this.state = { version: VAULT_VERSION, created_at: now, updated_at: now, data: {} };
            return this.state;
        }
        let raw: string;
        try {
            raw = fs.readFileSync(file, "utf-8");
        } catch (e) {
            throw new Error(`[vault] FATAL: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            // Don't include raw content in the error — never log secrets.
            throw new Error(`[vault] FATAL: vault file ${file} is corrupt JSON: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!parsed || typeof parsed !== "object") {
            throw new Error(`[vault] FATAL: vault file ${file} has wrong shape (not an object)`);
        }
        const obj = parsed as Partial<VaultFile>;
        if (typeof obj.version !== "number" || typeof obj.data !== "object" || obj.data === null) {
            throw new Error(`[vault] FATAL: vault file ${file} missing required fields (version, data)`);
        }
        if (obj.version !== VAULT_VERSION) {
            // Future: migrations would go here.
            throw new Error(`[vault] FATAL: vault file ${file} has unsupported version ${obj.version} (expected ${VAULT_VERSION})`);
        }
        this.state = {
            version: obj.version,
            created_at: typeof obj.created_at === "number" ? obj.created_at : Date.now(),
            updated_at: typeof obj.updated_at === "number" ? obj.updated_at : Date.now(),
            data: obj.data as Record<string, string>,
        };
        return this.state;
    }

    private save(): void {
        if (!this.state) return;
        this.state.updated_at = Date.now();
        const dir = secretSubdir();
        ensureSecretDir(dir);
        const tmp = tempPath();
        const final = vaultPath();
        // Write to a tmp file first, fsync, then atomic rename. This survives
        // mid-write crashes — the old vault remains valid until rename succeeds.
        const fd = fs.openSync(tmp, "w", 0o600);
        try {
            const payload = JSON.stringify(this.state, null, 2);
            fs.writeSync(fd, payload);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, final);
        // Re-apply mode in case the file pre-existed with looser perms (rename
        // preserves the source's mode, which we set to 0600 above — but defense
        // in depth).
        try { fs.chmodSync(final, 0o600); } catch { /* best effort */ }
    }

    get(key: string): string | undefined {
        return this.load().data[key];
    }

    has(key: string): boolean {
        return key in this.load().data;
    }

    set(key: string, value: string): void {
        if (typeof key !== "string" || key === "") {
            throw new Error("[vault] set: key must be a non-empty string");
        }
        if (typeof value !== "string") {
            throw new Error("[vault] set: value must be a string (use empty string to clear)");
        }
        const s = this.load();
        s.data[key] = value;
        this.save();
    }

    delete(key: string): boolean {
        const s = this.load();
        if (!(key in s.data)) return false;
        delete s.data[key];
        this.save();
        return true;
    }

    /** Returns keys only — NEVER returns values to callers without the explicit get(). */
    list(): string[] {
        return Object.keys(this.load().data).sort();
    }

    /**
     * Bulk-set multiple entries in one atomic write. Used by the onboarding
     * wizard so a half-completed wizard doesn't leave a partial vault.
     */
    bulkSet(entries: Record<string, string>): void {
        const s = this.load();
        for (const [k, v] of Object.entries(entries)) {
            if (typeof k !== "string" || k === "") continue;
            if (typeof v !== "string") continue;
            s.data[k] = v;
        }
        this.save();
    }

    /** Reset the in-memory cache. Tests / explicit reload only. */
    reset(): void {
        this.state = null;
    }

    /** Whether a vault file exists on disk yet (independent of in-memory state). */
    static fileExists(): boolean {
        return fs.existsSync(vaultPath());
    }

    /** Absolute path to the vault file. Useful for error messages. */
    static path(): string {
        return vaultPath();
    }
}

import { getOrCreate } from "./singletons.js";

export function getVault(): Vault {
    return getOrCreate("vault", () => new Vault());
}

export { Vault };
