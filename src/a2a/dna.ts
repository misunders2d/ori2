import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { botDir, ensureDir } from "../core/paths.js";
import { getBotName } from "../core/paths.js";
import { getFriends } from "./friends.js";
import { checkFilename, scanContent, type Finding } from "./secretScanner.js";
import type { DnaFeature, DnaFeaturesFile, DnaManifest, DnaManifestFile } from "./types.js";

// =============================================================================
// DNA exchange — feature catalog + on-the-fly packaging + import / snapshot /
// apply / rollback. Per the spec, the unit of exchange is a NAMED FEATURE
// (e.g. "clickup-integration"), not a list of file paths. Operators register
// features via register(); peers discover them via the agent card's
// `dna:<id>` skill entries; pulls are by feature id.
//
// Storage:
//   data/<bot>/dna_features.json   — catalog (atomic, mode 0600)
//   data/<bot>/dna_staging/<id>/   — extracted incoming tarballs awaiting apply
//   data/<bot>/dna_snapshots/<id>/ — auto-snapshots taken before each apply
//   data/<bot>/dna_audit.jsonl     — append-only event log
//
// Packaging shells out to `tar` (universal on Linux + macOS — same pattern
// as cloudflared). The tarball's contents:
//   manifest.json (at root)
//   .pi/extensions/<files...>
//   .pi/skills/<dirs...>/...
//   .pi/prompts/<files...>
// =============================================================================

const FILE_VERSION = 1;
const FEATURES_FILE = "dna_features.json";
const STAGING_DIR = "dna_staging";
const SNAPSHOT_DIR = "dna_snapshots";
const AUDIT_FILE = "dna_audit.jsonl";

/** Allowed roots inside the project for DNA file lists. */
const ALLOWED_PATH_PREFIXES: ReadonlyArray<string> = [
    ".pi/extensions/",
    ".pi/skills/",
    ".pi/prompts/",
];

/** Hard cap on tarball size for both export and import. Override via vault DNA_MAX_BYTES. */
export const DEFAULT_DNA_MAX_BYTES = 10 * 1024 * 1024;

const SNAPSHOT_KEEP = 20;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

function featuresPath(): string { return path.join(botDir(), FEATURES_FILE); }
function stagingRoot(): string { return path.join(botDir(), STAGING_DIR); }
function snapshotRoot(): string { return path.join(botDir(), SNAPSHOT_DIR); }
function auditPath(): string { return path.join(botDir(), AUDIT_FILE); }

function atomicWriteJson(file: string, data: unknown): void {
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
        fs.writeSync(fd, JSON.stringify(data, null, 2));
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
}

function appendAudit(event: Record<string, unknown>): void {
    ensureDir(path.dirname(auditPath()));
    const line = JSON.stringify({ at: Date.now(), ...event }) + "\n";
    fs.appendFileSync(auditPath(), line, { mode: 0o600 });
}

/** Validate a candidate file path: must live under an ALLOWED_PATH_PREFIXES root, no escaping. */
export function validateDnaPath(rel: string, projectRoot: string): { ok: true; abs: string } | { ok: false; reason: string } {
    if (!rel || typeof rel !== "string") return { ok: false, reason: "empty path" };
    if (path.isAbsolute(rel)) return { ok: false, reason: "absolute path not allowed (must be relative to project root)" };
    if (rel.includes("..")) return { ok: false, reason: "path traversal (..) not allowed" };
    const normalized = rel.replace(/\\/g, "/");
    if (!ALLOWED_PATH_PREFIXES.some((p) => normalized.startsWith(p))) {
        return { ok: false, reason: `path must start with one of ${ALLOWED_PATH_PREFIXES.join(", ")}` };
    }
    const abs = path.resolve(projectRoot, normalized);
    if (!abs.startsWith(projectRoot)) return { ok: false, reason: "resolved path escapes project root" };
    return { ok: true, abs };
}

export class DnaCatalog {
    private features: Map<string, DnaFeature> = new Map();
    private loaded = false;

    private load(): void {
        if (this.loaded) return;
        const file = featuresPath();
        if (!fs.existsSync(file)) { this.loaded = true; return; }
        let raw: string;
        try { raw = fs.readFileSync(file, "utf-8"); }
        catch (e) { throw new Error(`[dna] FATAL: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`); }
        let parsed: unknown;
        try { parsed = JSON.parse(raw); }
        catch (e) { throw new Error(`[dna] FATAL: dna_features.json corrupt: ${e instanceof Error ? e.message : String(e)}`); }
        const obj = parsed as Partial<DnaFeaturesFile>;
        if (!obj.features || typeof obj.features !== "object") {
            throw new Error("[dna] FATAL: dna_features.json missing 'features' object");
        }
        for (const [id, raw] of Object.entries(obj.features)) {
            if (!raw || typeof raw !== "object") continue;
            const r = raw as Partial<DnaFeature>;
            if (typeof r.description !== "string" || !Array.isArray(r.files)) continue;
            this.features.set(id, {
                description: r.description,
                files: r.files.filter((f): f is string => typeof f === "string"),
                ...(Array.isArray(r.tags) ? { tags: r.tags.filter((t): t is string => typeof t === "string") } : {}),
                version: typeof r.version === "string" ? r.version : "1.0.0",
                share_with: Array.isArray(r.share_with)
                    ? r.share_with.filter((s): s is string => typeof s === "string")
                    : ["*"],
                registered_at: typeof r.registered_at === "number" ? r.registered_at : Date.now(),
                registered_by: typeof r.registered_by === "string" ? r.registered_by : "unknown",
            });
        }
        this.loaded = true;
    }

    private save(): void {
        const data: DnaFeaturesFile = {
            version: FILE_VERSION,
            features: Object.fromEntries(this.features.entries()),
        };
        atomicWriteJson(featuresPath(), data);
    }

    register(
        id: string,
        opts: {
            description: string;
            files: string[];
            tags?: string[];
            version?: string;
            share_with?: string[];
            registered_by: string;
        },
    ): DnaFeature {
        if (!id || typeof id !== "string") throw new Error("[dna] register: id required");
        if (id.startsWith("dna:")) throw new Error('[dna] register: id must NOT start with "dna:" (the prefix is added in the agent card)');
        this.load();
        const projectRoot = process.cwd();
        for (const f of opts.files) {
            const v = validateDnaPath(f, projectRoot);
            if (!v.ok) throw new Error(`[dna] register: invalid file path "${f}": ${v.reason}`);
            if (checkFilename(f)) throw new Error(`[dna] register: file "${f}" is on the hard-forbidden filename list (vault/env/key)`);
        }
        const feature: DnaFeature = {
            description: opts.description,
            files: [...opts.files],
            ...(opts.tags ? { tags: [...opts.tags] } : {}),
            version: opts.version ?? "1.0.0",
            share_with: opts.share_with ?? ["*"],
            registered_at: Date.now(),
            registered_by: opts.registered_by,
        };
        this.features.set(id, feature);
        this.save();
        appendAudit({ event: "feature_registered", id, files: feature.files, share_with: feature.share_with });
        return feature;
    }

    unregister(id: string): boolean {
        this.load();
        const removed = this.features.delete(id);
        if (removed) {
            this.save();
            appendAudit({ event: "feature_unregistered", id });
        }
        return removed;
    }

    list(): Array<{ id: string } & DnaFeature> {
        this.load();
        return Array.from(this.features.entries()).map(([id, f]) => ({ id, ...f }));
    }

    get(id: string): DnaFeature | undefined {
        this.load();
        return this.features.get(id);
    }

    /** For agent card composition. Returns DNA features as `{id, description, tags}` entries. */
    asAgentCardEntries(): Array<{ id: string; description: string; tags?: string[] }> {
        return this.list().map((f) => ({
            id: f.id,
            description: f.description,
            ...(f.tags ? { tags: f.tags } : {}),
        }));
    }

    /** Test-only — clear in-memory cache. */
    reset(): void {
        this.loaded = false;
        this.features.clear();
    }

    /** True if `friendName` is permitted to pull `featureId`. */
    canShareWith(featureId: string, friendName: string): boolean {
        const f = this.get(featureId);
        if (!f) return false;
        if (f.share_with.includes("*")) return true;
        return f.share_with.includes(friendName);
    }
}

let _catalog: DnaCatalog | null = null;
export function getDnaCatalog(): DnaCatalog {
    if (!_catalog) _catalog = new DnaCatalog();
    return _catalog;
}

// ---------------------------------------------------------------------------
// Packaging — build a tarball on the fly for /dna/<feature> requests
// ---------------------------------------------------------------------------

export interface PackageResult {
    /** Absolute path to the built tarball. Caller streams + cleans up. */
    tarPath: string;
    sha256: string;
    manifest: DnaManifest;
}

/**
 * Build a tarball for a feature, scanning every file's content for secrets
 * before inclusion. Throws if the feature is missing OR any secret finding
 * blocks (caller can pre-check via scanFeature).
 */
export async function packageFeature(featureId: string, opts: { piSdkVersion: string }): Promise<PackageResult> {
    const catalog = getDnaCatalog();
    const f = catalog.get(featureId);
    if (!f) throw new Error(`[dna] feature not found: ${featureId}`);

    const projectRoot = process.cwd();
    const stageId = randomUUID();
    const buildDir = path.join(stagingRoot(), `_build-${stageId}`);
    ensureDir(buildDir);

    // Re-scan + assemble the manifest's file list.
    const findings: Finding[] = [];
    const manifestFiles: DnaManifestFile[] = [];
    for (const rel of f.files) {
        const v = validateDnaPath(rel, projectRoot);
        if (!v.ok) {
            await rmrf(buildDir);
            throw new Error(`[dna] invalid path during package: ${rel} (${v.reason})`);
        }
        if (checkFilename(rel)) {
            await rmrf(buildDir);
            throw new Error(`[dna] forbidden filename during package: ${rel}`);
        }
        if (!fs.existsSync(v.abs)) {
            await rmrf(buildDir);
            throw new Error(`[dna] missing file during package: ${rel}`);
        }
        const content = fs.readFileSync(v.abs, "utf-8");
        const fileFindings = scanContent(rel, content);
        findings.push(...fileFindings);

        // Stage the file at its relative path inside buildDir.
        const dest = path.join(buildDir, rel);
        ensureDir(path.dirname(dest));
        fs.copyFileSync(v.abs, dest);

        const stat = fs.statSync(v.abs);
        manifestFiles.push({
            path: rel,
            sha256: createHash("sha256").update(content, "utf-8").digest("hex"),
            size: stat.size,
        });
    }

    if (findings.length > 0) {
        await rmrf(buildDir);
        const reportLines = findings.slice(0, 8).map((f) =>
            `  ${f.file}:${f.line}:${f.column} [${f.kind}/${f.pattern}] ${f.matchedText}`,
        );
        const more = findings.length > 8 ? `\n  …and ${findings.length - 8} more` : "";
        throw new Error(`[dna] secrets detected — refusing to package "${featureId}":\n${reportLines.join("\n")}${more}`);
    }

    const manifest: DnaManifest = {
        feature_id: featureId,
        feature_version: f.version,
        source_bot: getBotName(),
        source_agent_id: `ori2-${getBotName().toLowerCase()}`,
        ori2_version: "1.0.0",
        pi_sdk_version: opts.piSdkVersion,
        exported_at: Date.now(),
        files: manifestFiles,
        description: f.description,
        tags: f.tags ?? [],
    };
    fs.writeFileSync(path.join(buildDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    // Tar the build dir into a final tarball file.
    const tarPath = path.join(stagingRoot(), `${featureId}-${stageId}.tar.gz`);
    await runTar(["-czf", tarPath, "-C", buildDir, "."]);

    // sha256 of the resulting archive (callers can attach to logs).
    const tarBytes = fs.readFileSync(tarPath);
    const sha256 = createHash("sha256").update(tarBytes).digest("hex");

    await rmrf(buildDir);
    appendAudit({ event: "feature_packaged", id: featureId, sha256, size: tarBytes.length });
    return { tarPath, sha256, manifest };
}

// ---------------------------------------------------------------------------
// Import — pull from a friend, stage, scan, conflict-check
// ---------------------------------------------------------------------------

export interface PullConflict {
    path: string;
    /** "missing" = no local file (no conflict, will be a new file on apply).
     *  "identical" = local sha matches incoming (no-op on apply).
     *  "differs" = local file differs (operator picks strategy on apply). */
    kind: "missing" | "identical" | "differs";
    localSha256?: string;
    incomingSha256?: string;
}

export interface PullResult {
    importId: string;
    stagingDir: string;
    manifest: DnaManifest;
    conflicts: PullConflict[];
}

/** Download a feature from a friend, extract + verify, return manifest + conflicts. Does NOT touch .pi/. */
export async function pullDnaFromFriend(
    friendName: string,
    featureId: string,
    opts: { maxBytes?: number; fetchImpl?: typeof fetch } = {},
): Promise<PullResult> {
    const friends = getFriends();
    const friend = friends.get(friendName);
    if (!friend) throw new Error(`[dna] unknown friend: ${friendName}`);
    const key = friends.getOutboundKey(friendName);
    if (!key) throw new Error(`[dna] friend ${friendName} has no outbound key`);

    const fetchImpl = opts.fetchImpl ?? fetch;
    const maxBytes = opts.maxBytes ?? DEFAULT_DNA_MAX_BYTES;
    const url = `${friend.base_url.replace(/\/+$/, "")}/dna/${encodeURIComponent(featureId)}.tar.gz`;
    const res = await fetchImpl(url, {
        method: "GET",
        headers: { "x-a2a-api-key": key },
    });
    if (!res.ok) throw new Error(`[dna] pull failed (${res.status}): ${await safeReadText(res)}`);

    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
        throw new Error(`[dna] tarball too large: ${buf.byteLength} bytes > cap ${maxBytes}`);
    }

    const importId = randomUUID();
    const dir = path.join(stagingRoot(), importId);
    ensureDir(dir);

    const tarPath = path.join(dir, "_incoming.tar.gz");
    fs.writeFileSync(tarPath, Buffer.from(buf));

    await runTar(["-xzf", tarPath, "-C", dir]);
    fs.unlinkSync(tarPath);

    const manifestPath = path.join(dir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
        await rmrf(dir);
        throw new Error("[dna] tarball missing manifest.json");
    }
    let manifest: DnaManifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as DnaManifest; }
    catch (e) { await rmrf(dir); throw new Error(`[dna] manifest.json invalid: ${e instanceof Error ? e.message : String(e)}`); }

    // Verify per-file sha256 + re-scan for secrets (defence in depth).
    const projectRoot = process.cwd();
    const findings: Finding[] = [];
    for (const fileEntry of manifest.files) {
        const v = validateDnaPath(fileEntry.path, projectRoot);
        if (!v.ok) { await rmrf(dir); throw new Error(`[dna] manifest path rejected: ${fileEntry.path} (${v.reason})`); }
        if (checkFilename(fileEntry.path)) { await rmrf(dir); throw new Error(`[dna] manifest contains forbidden filename: ${fileEntry.path}`); }
        const stagedAbs = path.join(dir, fileEntry.path);
        if (!fs.existsSync(stagedAbs)) { await rmrf(dir); throw new Error(`[dna] tarball missing declared file: ${fileEntry.path}`); }
        const content = fs.readFileSync(stagedAbs, "utf-8");
        const sha = createHash("sha256").update(content, "utf-8").digest("hex");
        if (sha !== fileEntry.sha256) {
            await rmrf(dir);
            throw new Error(`[dna] sha256 mismatch on ${fileEntry.path}: manifest=${fileEntry.sha256.slice(0, 12)} actual=${sha.slice(0, 12)}`);
        }
        findings.push(...scanContent(fileEntry.path, content));
    }
    if (findings.length > 0) {
        await rmrf(dir);
        const lines = findings.slice(0, 8).map((f) => `  ${f.file}:${f.line} [${f.pattern}]`);
        throw new Error(`[dna] sender's tarball contains secrets — refusing to stage:\n${lines.join("\n")}`);
    }

    // Conflict detection.
    const conflicts: PullConflict[] = manifest.files.map((fileEntry) => {
        const liveAbs = path.resolve(projectRoot, fileEntry.path);
        if (!fs.existsSync(liveAbs)) return { path: fileEntry.path, kind: "missing", incomingSha256: fileEntry.sha256 };
        const liveSha = createHash("sha256").update(fs.readFileSync(liveAbs)).digest("hex");
        if (liveSha === fileEntry.sha256) return { path: fileEntry.path, kind: "identical", localSha256: liveSha, incomingSha256: fileEntry.sha256 };
        return { path: fileEntry.path, kind: "differs", localSha256: liveSha, incomingSha256: fileEntry.sha256 };
    });

    appendAudit({
        event: "import_staged",
        import_id: importId,
        from: friendName,
        feature_id: featureId,
        files: manifest.files.map((f) => f.path),
        conflicts: conflicts.filter((c) => c.kind === "differs").map((c) => c.path),
    });

    return { importId, stagingDir: dir, manifest, conflicts };
}

// ---------------------------------------------------------------------------
// Snapshot + apply + rollback
// ---------------------------------------------------------------------------

export type ApplyStrategy = "abort" | "overwrite" | "rename";

export interface ApplyResult {
    snapshotId: string;
    status: "applied" | "rolled-back" | "aborted";
    appliedFiles: string[];
    renamedFiles?: string[];
    rollbackReason?: string;
}

export interface ApplyOptions {
    /** Override how to invoke the test suite. Defaults to `npm test`. */
    runTestsCmd?: string[];
    /** Project root — defaults to process.cwd(). */
    projectRoot?: string;
}

/**
 * Apply a staged import. Snapshots .pi/ first, copies per strategy, runs
 * `npm test`, rolls back automatically on test failure.
 */
export async function applyDna(
    importId: string,
    strategy: ApplyStrategy = "abort",
    opts: ApplyOptions = {},
): Promise<ApplyResult> {
    const projectRoot = opts.projectRoot ?? process.cwd();
    const stagingDir = path.join(stagingRoot(), importId);
    if (!fs.existsSync(stagingDir)) throw new Error(`[dna] no staged import: ${importId}`);
    const manifestPath = path.join(stagingDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) throw new Error(`[dna] staged import missing manifest`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as DnaManifest;

    // Conflict check at apply time (state may have shifted since pull).
    const willOverwrite: string[] = [];
    for (const fEntry of manifest.files) {
        const liveAbs = path.resolve(projectRoot, fEntry.path);
        if (!fs.existsSync(liveAbs)) continue;
        const liveSha = createHash("sha256").update(fs.readFileSync(liveAbs)).digest("hex");
        if (liveSha === fEntry.sha256) continue; // identical — no-op
        willOverwrite.push(fEntry.path);
    }
    if (willOverwrite.length > 0 && strategy === "abort") {
        appendAudit({ event: "apply_aborted", import_id: importId, conflicts: willOverwrite });
        return {
            snapshotId: "",
            status: "aborted",
            appliedFiles: [],
            rollbackReason: `${willOverwrite.length} file(s) would be overwritten — re-run with strategy=overwrite or rename`,
        };
    }

    // Snapshot .pi/ — cp -r.
    const snapshotId = `snap-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const snapshotDir = path.join(snapshotRoot(), snapshotId);
    ensureDir(snapshotRoot());
    const piRoot = path.resolve(projectRoot, ".pi");
    if (fs.existsSync(piRoot)) {
        await cpR(piRoot, snapshotDir);
    } else {
        ensureDir(snapshotDir); // empty marker so rollback is well-defined
    }
    appendAudit({ event: "snapshot_taken", snapshot_id: snapshotId, source: ".pi" });

    // Copy / rename / overwrite files per strategy.
    const appliedFiles: string[] = [];
    const renamedFiles: string[] = [];
    for (const fEntry of manifest.files) {
        const stagedAbs = path.join(stagingDir, fEntry.path);
        const liveAbs = path.resolve(projectRoot, fEntry.path);
        ensureDir(path.dirname(liveAbs));
        if (fs.existsSync(liveAbs) && strategy === "rename") {
            const liveSha = createHash("sha256").update(fs.readFileSync(liveAbs)).digest("hex");
            if (liveSha !== fEntry.sha256) {
                const ext = path.extname(liveAbs);
                const base = liveAbs.slice(0, liveAbs.length - ext.length);
                const ts = new Date().toISOString().replace(/[:.]/g, "-");
                const renamed = `${base}.local.${ts}${ext}`;
                fs.renameSync(liveAbs, renamed);
                renamedFiles.push(renamed);
            }
        }
        fs.copyFileSync(stagedAbs, liveAbs);
        appliedFiles.push(fEntry.path);
    }

    // Run tests; rollback if they fail.
    const cmd = opts.runTestsCmd ?? ["npm", "test", "--silent"];
    const testResult = await runChild(cmd[0]!, cmd.slice(1), projectRoot);
    if (testResult.code !== 0) {
        // Rollback: wipe .pi/ and restore from snapshot.
        if (fs.existsSync(piRoot)) await rmrf(piRoot);
        if (fs.existsSync(snapshotDir)) await cpR(snapshotDir, piRoot);
        // Also restore renamed files (move them back).
        for (const renamed of renamedFiles) {
            const orig = renamed.replace(/\.local\.[^.]+\.\w+$/, "") + path.extname(renamed);
            try { if (fs.existsSync(renamed)) fs.renameSync(renamed, orig); } catch { /* best-effort */ }
        }
        appendAudit({
            event: "apply_rolled_back",
            import_id: importId,
            snapshot_id: snapshotId,
            test_stderr_tail: testResult.stderr.slice(-400),
        });
        const result: ApplyResult = {
            snapshotId,
            status: "rolled-back",
            appliedFiles: [],
            rollbackReason: `npm test failed (exit ${testResult.code}). Stderr tail: ${testResult.stderr.slice(-400)}`,
        };
        if (renamedFiles.length > 0) result.renamedFiles = renamedFiles;
        return result;
    }

    appendAudit({
        event: "apply_succeeded",
        import_id: importId,
        snapshot_id: snapshotId,
        feature_id: manifest.feature_id,
        applied_files: appliedFiles,
    });
    pruneSnapshots();

    const result: ApplyResult = { snapshotId, status: "applied", appliedFiles };
    if (renamedFiles.length > 0) result.renamedFiles = renamedFiles;
    return result;
}

/** Restore .pi/ from a snapshot. Idempotent if the snapshot exists. */
export async function rollbackToSnapshot(snapshotId: string, projectRoot: string = process.cwd()): Promise<void> {
    const dir = path.join(snapshotRoot(), snapshotId);
    if (!fs.existsSync(dir)) throw new Error(`[dna] snapshot not found: ${snapshotId}`);
    const piRoot = path.resolve(projectRoot, ".pi");
    if (fs.existsSync(piRoot)) await rmrf(piRoot);
    await cpR(dir, piRoot);
    appendAudit({ event: "rollback", snapshot_id: snapshotId });
}

export interface SnapshotListing { id: string; createdAt: number; sizeBytes: number; }

export function listSnapshots(): SnapshotListing[] {
    const root = snapshotRoot();
    if (!fs.existsSync(root)) return [];
    const out: SnapshotListing[] = [];
    for (const name of fs.readdirSync(root)) {
        const dir = path.join(root, name);
        try {
            const stat = fs.statSync(dir);
            if (!stat.isDirectory()) continue;
            out.push({ id: name, createdAt: stat.mtimeMs, sizeBytes: dirSize(dir) });
        } catch { /* skip */ }
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
}

export interface ImportListing { id: string; createdAt: number; manifest?: DnaManifest; }

export function listImports(): ImportListing[] {
    const root = stagingRoot();
    if (!fs.existsSync(root)) return [];
    const out: ImportListing[] = [];
    for (const name of fs.readdirSync(root)) {
        if (name.startsWith("_build-")) continue; // mid-flight build dir
        const dir = path.join(root, name);
        try {
            const stat = fs.statSync(dir);
            if (!stat.isDirectory()) continue;
            const manifestPath = path.join(dir, "manifest.json");
            const entry: ImportListing = { id: name, createdAt: stat.mtimeMs };
            if (fs.existsSync(manifestPath)) {
                try { entry.manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as DnaManifest; }
                catch { /* skip */ }
            }
            out.push(entry);
        } catch { /* skip */ }
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
}

/** Keep only the most recent SNAPSHOT_KEEP snapshots; delete the rest. */
export function pruneSnapshots(keep: number = SNAPSHOT_KEEP): void {
    const all = listSnapshots();
    if (all.length <= keep) return;
    for (const s of all.slice(keep)) {
        const dir = path.join(snapshotRoot(), s.id);
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            appendAudit({ event: "snapshot_pruned", snapshot_id: s.id });
        } catch { /* best-effort */ }
    }
}

// ---------------------------------------------------------------------------
// shell helpers
// ---------------------------------------------------------------------------

function runTar(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        proc.once("error", reject);
        proc.once("close", (code) => {
            if (code !== 0) reject(new Error(`tar exited ${code}: ${stderr}`));
            else resolve();
        });
    });
}

function runChild(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd });
        let stdout = ""; let stderr = "";
        proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
        proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
        proc.once("error", () => resolve({ code: 1, stdout, stderr: stderr + "\nspawn error" }));
        proc.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

async function rmrf(target: string): Promise<void> {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function cpR(src: string, dest: string): Promise<void> {
    fs.cpSync(src, dest, { recursive: true });
}

function dirSize(dir: string): number {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) total += dirSize(p);
        else if (entry.isFile()) {
            try { total += fs.statSync(p).size; } catch { /* ignore */ }
        }
    }
    return total;
}

async function safeReadText(res: Response): Promise<string> {
    try { return (await res.text()).slice(0, 400); } catch { return "(unreadable)"; }
}
