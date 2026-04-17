import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import { botSubdir } from "../../src/core/paths.js";
import { fileToPayload, type MediaSaveContext } from "../../src/transport/media.js";

// =============================================================================
// attachments — agent-facing surface for files the user has sent.
//
// Transport adapters (telegram.ts today; slack / a2a tomorrow) already save
// inbound documents/images/audio to data/<bot>/incoming/<platform>/. The
// extraction path fires at the BOUNDARY so the agent receives text where
// possible — but that content lives in the CURRENT message's attachments,
// not in a queryable store. If the user sent a Helium10 CSV an hour ago
// and now asks "what were the top 10 keywords from that file?", the agent
// has no tool to re-read it.
//
// These two tools close that gap. They're deliberately narrow in scope:
// read-only, sandboxed to the incoming directory, same extraction pipeline
// the adapter uses on ingest (fileToPayload — PDFs via pdf-parse, text/csv/
// json decoded UTF-8, images returned with filename only since inlining
// base64 into tool output isn't useful).
//
// Security:
//   - `filename` must match a file directly inside one of the per-platform
//     incoming subdirectories. Any `..`, absolute path, or separator in
//     the name is rejected.
//   - No write / delete operations. If the operator wants cleanup, they do
//     it at the filesystem level.
// =============================================================================

const INCOMING_ROOT = (): string => botSubdir("incoming");

interface FileEntry {
    platform: string;
    filename: string;
    absPath: string;
    sizeBytes: number;
    mtime: number;
}

/**
 * Enumerate files across all platform subdirectories under data/<bot>/incoming/.
 * Returns most-recent-first. Optionally narrow to one platform.
 */
function scan(platform: string | undefined): FileEntry[] {
    const root = INCOMING_ROOT();
    if (!fs.existsSync(root)) return [];

    const platforms = platform
        ? [platform]
        : fs.readdirSync(root, { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .map((d) => d.name);

    const out: FileEntry[] = [];
    for (const p of platforms) {
        const dir = path.join(root, p);
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            let st: fs.Stats;
            try { st = fs.statSync(full); } catch { continue; }
            if (!st.isFile()) continue;
            out.push({
                platform: p,
                filename: name,
                absPath: full,
                sizeBytes: st.size,
                mtime: st.mtimeMs,
            });
        }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
}

/**
 * Validate that `filename` points to an actual file inside the incoming tree
 * for the given platform (or any platform if none specified). Blocks path
 * traversal. Returns the resolved absolute path if valid, else throws.
 */
function resolveSafe(filename: string, platform: string | undefined): FileEntry {
    // Reject anything that looks like a path, not a basename.
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..") || path.isAbsolute(filename)) {
        throw new Error(`Invalid filename "${filename}": must be a bare filename (no path separators or '..').`);
    }

    const candidates = scan(platform).filter((e) => e.filename === filename);
    if (candidates.length === 0) {
        throw new Error(
            `No attachment named "${filename}"${platform ? ` in platform "${platform}"` : ""}. ` +
            `Call list_attachments to see what's available.`,
        );
    }
    if (candidates.length > 1) {
        throw new Error(
            `Ambiguous attachment "${filename}" — exists in multiple platforms (${candidates.map((c) => c.platform).join(", ")}). ` +
            `Pass the platform parameter to disambiguate.`,
        );
    }
    return candidates[0]!;
}

/** Naive mime inference from extension. Used when the adapter didn't stamp one. */
function guessMime(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
        case ".pdf": return "application/pdf";
        case ".txt": return "text/plain";
        case ".md": return "text/markdown";
        case ".csv": return "text/csv";
        case ".tsv": return "text/tab-separated-values";
        case ".json": return "application/json";
        case ".xml": return "application/xml";
        case ".yaml": case ".yml": return "application/yaml";
        case ".html": case ".htm": return "text/html";
        case ".png": return "image/png";
        case ".jpg": case ".jpeg": return "image/jpeg";
        case ".webp": return "image/webp";
        case ".gif": return "image/gif";
        case ".mp3": return "audio/mpeg";
        case ".ogg": return "audio/ogg";
        case ".mp4": return "video/mp4";
        default: return "application/octet-stream";
    }
}

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "list_attachments",
        label: "List Attachments",
        description:
            "List files the user has sent via any platform (Telegram documents, Slack uploads, etc.). " +
            "Returned most-recent-first with size and modification time so the agent can decide " +
            "which to read. Use this to answer 'what files did I share earlier?' or before " +
            "`read_attachment`. File contents are NOT returned here — this is a directory-listing " +
            "surface. Data stays local to the bot (data/<bot>/incoming/<platform>/).",
        parameters: Type.Object({
            platform: Type.Optional(Type.String({
                description: "Narrow to one platform ('telegram', 'slack', ...). Omit to list all.",
            })),
            limit: Type.Optional(Type.Integer({
                description: "Return at most this many entries. Defaults to 20.",
                minimum: 1,
                maximum: 500,
            })),
        }),
        async execute(_id, params) {
            const cap = params.limit ?? 20;
            const entries = scan(params.platform).slice(0, cap);
            if (entries.length === 0) {
                return {
                    content: [{ type: "text", text: "No attachments found." }],
                    details: { count: 0, entries: [] },
                };
            }
            const lines = [
                `Found ${entries.length} attachment${entries.length === 1 ? "" : "s"}${params.platform ? ` (${params.platform})` : ""}, most recent first:`,
                "",
            ];
            for (const e of entries) {
                const when = new Date(e.mtime).toISOString().replace("T", " ").slice(0, 16);
                const size = e.sizeBytes < 1024
                    ? `${e.sizeBytes} B`
                    : e.sizeBytes < 1024 * 1024
                        ? `${(e.sizeBytes / 1024).toFixed(1)} KB`
                        : `${(e.sizeBytes / 1024 / 1024).toFixed(2)} MB`;
                lines.push(`  [${e.platform}] ${e.filename}  (${size}, ${when})`);
            }
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: {
                    count: entries.length,
                    entries: entries.map((e) => ({
                        platform: e.platform,
                        filename: e.filename,
                        sizeBytes: e.sizeBytes,
                        mtime: e.mtime,
                    })),
                },
            };
        },
    });

    pi.registerTool({
        name: "read_attachment",
        label: "Read Attachment",
        description:
            "Return the content of a previously-uploaded attachment — extracted text for PDFs, " +
            "CSVs, JSON, Markdown, and other text formats; metadata only for images/audio/video " +
            "(the filename is enough to feed a vision-capable model via other tools). " +
            "Use `list_attachments` first to see valid names. " +
            "Large files: pass `max_chars` to truncate the response (default 50_000 chars for text). " +
            "Content is read from data/<bot>/incoming/<platform>/<filename> — no arbitrary path access.",
        parameters: Type.Object({
            filename: Type.String({ description: "Exact filename as shown by list_attachments (no path prefix)." }),
            platform: Type.Optional(Type.String({ description: "Disambiguate if the same filename exists under multiple platforms." })),
            max_chars: Type.Optional(Type.Integer({
                description: "Truncate extracted text after this many chars. Ignored for binary/image files.",
                minimum: 100,
                maximum: 500_000,
            })),
        }),
        async execute(_id, params) {
            const entry = resolveSafe(params.filename, params.platform);
            const cap = params.max_chars ?? 50_000;

            const buf = fs.readFileSync(entry.absPath);
            const mime = guessMime(entry.filename);

            // Reuse the adapter-side extraction pipeline so we get PDF text
            // via pdf-parse, UTF-8 decode for text/csv/json, etc. — exactly
            // the same path the user originally saw when the file arrived.
            // saveBinary is a noop here because we already have the file on
            // disk at entry.absPath; fileToPayload only calls it for true
            // binary fallback where our absPath is fine.
            const mediaCtx: MediaSaveContext = {
                incomingDir: path.dirname(entry.absPath),
                saveBinary: async () => entry.absPath,
            };
            const payload = await fileToPayload(buf, mime, entry.filename, mediaCtx);

            if (payload.kind === "text") {
                const full = payload.text;
                const truncated = full.length > cap ? full.slice(0, cap) : full;
                const suffix = full.length > cap
                    ? `\n\n[truncated — showing ${cap} of ${full.length} chars; pass a higher max_chars to see more]`
                    : "";
                const details: Record<string, unknown> = {
                    kind: "text",
                    filename: entry.filename,
                    platform: entry.platform,
                    mime,
                    sizeBytes: entry.sizeBytes,
                    extractedChars: full.length,
                    truncated: full.length > cap,
                };
                return {
                    content: [{ type: "text", text: truncated + suffix }],
                    details,
                };
            }

            if (payload.kind === "image") {
                const details: Record<string, unknown> = {
                    kind: "image",
                    filename: entry.filename,
                    platform: entry.platform,
                    mime,
                    sizeBytes: entry.sizeBytes,
                    path: entry.absPath,
                };
                return {
                    content: [{
                        type: "text",
                        text: `Image attachment: ${entry.filename} (${mime}, ${entry.sizeBytes} bytes).\n\nImages aren't inlined here — use a vision-capable model in a tool that accepts the file path (${entry.absPath}) or ask the user to resend the image attached to a regular chat message.`,
                    }],
                    details,
                };
            }

            // binary
            const details: Record<string, unknown> = {
                kind: "binary",
                filename: entry.filename,
                platform: entry.platform,
                mime,
                sizeBytes: entry.sizeBytes,
                path: entry.absPath,
            };
            return {
                content: [{
                    type: "text",
                    text: `Binary attachment: ${entry.filename} (${mime}, ${entry.sizeBytes} bytes). No text extraction available. Path: ${entry.absPath}`,
                }],
                details,
            };
        },
    });
}
