import path from "node:path";
import type { MediaPayload } from "./types.js";

// =============================================================================
// Media extraction at the adapter boundary.
//
// Adapters (Telegram, Slack, etc.) call these helpers immediately after
// downloading a file from the platform, BEFORE handing the payload to the
// dispatcher. The agent never sees raw binary unless the file is genuinely
// a binary the LLM can't process — in which case it gets a path reference.
//
// Dispatch by mimeType:
//   - image/png, image/jpeg, image/jpg, image/webp, image/gif → MediaPayload.image (base64)
//   - application/pdf                                          → extracted text via pdf-parse
//   - text/* (csv, plain, markdown, html, etc.)                → decoded UTF-8 text
//   - application/json, application/xml, application/yaml      → decoded UTF-8 text
//   - everything else                                          → MediaPayload.binary (path ref)
//
// PDF parsing is lazy-imported (`pdf-parse` pulls in pdfjs-dist which is a few
// MB on disk + ~100ms init). Adapters that never see PDFs don't pay the cost.
// =============================================================================

const IMAGE_MIME_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
]);

const TEXT_MIME_TYPES = new Set([
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/tab-separated-values",
    "text/html",
    "text/xml",
    "application/json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
]);

/** Save buffer to a known location and return MediaPayload describing it. */
export interface MediaSaveContext {
    /** Where binary fallbacks get saved. Adapter chooses (e.g. data/<bot>/incoming/). */
    incomingDir: string;
    /** Save the buffer + return absolute path. Adapter implements (allows mocking). */
    saveBinary: (filename: string, buffer: Buffer) => Promise<string>;
}

/**
 * Convert a downloaded file into a MediaPayload the agent can consume.
 *
 * @param buffer    file bytes
 * @param mimeType  best-effort mime from the platform (Telegram document mime_type, Slack file mimetype, etc.)
 * @param filename  original filename if known
 * @param ctx       hooks for saving binary fallbacks
 */
export async function fileToPayload(
    buffer: Buffer,
    mimeType: string,
    filename: string | undefined,
    ctx: MediaSaveContext,
): Promise<MediaPayload> {
    const mt = mimeType.toLowerCase();

    // Image branch — base64 inline for vision-capable models.
    if (IMAGE_MIME_TYPES.has(mt)) {
        const base: MediaPayload = {
            kind: "image",
            mimeType: mt,
            data: buffer.toString("base64"),
        };
        if (filename !== undefined) (base as { filename?: string }).filename = filename;
        return base;
    }

    // PDF branch — extract text via pdf-parse (lazy-imported).
    if (mt === "application/pdf") {
        try {
            const text = await extractPdfText(buffer);
            const base: MediaPayload = {
                kind: "text",
                mimeType: mt,
                text,
                sourceBytes: buffer.length,
            };
            if (filename !== undefined) (base as { filename?: string }).filename = filename;
            return base;
        } catch (e) {
            // PDF was malformed or pdf-parse choked. Fall back to binary so the
            // agent at least sees the file exists and can decide what to do.
            const reason = e instanceof Error ? e.message : String(e);
            console.error(`[media] PDF text extraction failed (${filename ?? "<unnamed>"}): ${reason}`);
        }
    }

    // Text branch — decode and pass through.
    if (TEXT_MIME_TYPES.has(mt) || mt.startsWith("text/")) {
        const text = buffer.toString("utf-8");
        const base: MediaPayload = {
            kind: "text",
            mimeType: mt,
            text,
            sourceBytes: buffer.length,
        };
        if (filename !== undefined) (base as { filename?: string }).filename = filename;
        return base;
    }

    // Binary fallback — save to disk, give agent a reference.
    const safeName = filename
        ? path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_")
        : `attachment-${Date.now()}.bin`;
    const localPath = await ctx.saveBinary(safeName, buffer);
    const base: MediaPayload = {
        kind: "binary",
        mimeType: mt || "application/octet-stream",
        localPath,
        sizeBytes: buffer.length,
    };
    if (filename !== undefined) (base as { filename?: string }).filename = filename;
    return base;
}

async function extractPdfText(buffer: Buffer): Promise<string> {
    // Lazy import — only pay the cost on first PDF.
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
        const result = await parser.getText();
        return result.text;
    } finally {
        await parser.destroy();
    }
}
