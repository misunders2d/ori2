import path from "node:path";
import type { MediaPayload } from "./types.js";
import { moderateMedia, type ModerationResult } from "../core/contentModerator.js";

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
 * Convert a downloaded file into MediaPayload(s) the agent can consume.
 *
 * Returns AN ARRAY because multimodal moderation can attach a sibling text
 * payload (transcript / description) alongside the image/audio so the local
 * cosine guardrail also runs over it. Most cases return a single-element
 * array; image/audio/video can return [original, transcript-text]; blocked
 * content returns [block-notice-text] only.
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
): Promise<MediaPayload[]> {
    const mt = mimeType.toLowerCase();

    // Image branch — moderate first, then attach transcript alongside the
    // image so vision-capable models AND the local cosine guardrail both
    // see the same content. On injection: drop the image entirely and
    // return only a block-notice text payload.
    if (IMAGE_MIME_TYPES.has(mt)) {
        const verdict = await moderateMedia(buffer, mt, filename);
        if (verdict.injection && verdict.confidence >= 0.7) {
            return [blockNoticePayload("image", verdict, filename)];
        }
        const image: MediaPayload = {
            kind: "image",
            mimeType: mt,
            data: buffer.toString("base64"),
        };
        if (filename !== undefined) (image as { filename?: string }).filename = filename;
        const out: MediaPayload[] = [image];
        const sibling = transcriptSiblingFor(verdict, "image", filename);
        if (sibling) out.push(sibling);
        return out;
    }

    // Audio / video branch — same moderation flow. Most LLMs can ingest audio
    // less reliably than text, so the transcript sibling is more important
    // here; we ALSO save the binary in case the model wants the raw file via
    // a tool (e.g. a future audio-analyse tool).
    if (mt.startsWith("audio/") || mt.startsWith("video/")) {
        const verdict = await moderateMedia(buffer, mt, filename);
        if (verdict.injection && verdict.confidence >= 0.7) {
            return [blockNoticePayload(mt.startsWith("audio/") ? "audio" : "video", verdict, filename)];
        }
        const safeName = filename
            ? path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_")
            : `attachment-${Date.now()}.bin`;
        const localPath = await ctx.saveBinary(safeName, buffer);
        const binary: MediaPayload = {
            kind: "binary",
            mimeType: mt,
            localPath,
            sizeBytes: buffer.length,
        };
        if (filename !== undefined) (binary as { filename?: string }).filename = filename;
        const out: MediaPayload[] = [binary];
        const sibling = transcriptSiblingFor(verdict, mt.startsWith("audio/") ? "audio" : "video", filename);
        if (sibling) out.push(sibling);
        return out;
    }

    // PDF branch — extract text via pdf-parse (lazy-imported). Already plain
    // text so the local cosine guardrail covers it; no moderator call needed.
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
            return [base];
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
        return [base];
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
    return [base];
}

/**
 * Build a sibling text payload from a successful moderation result. The
 * transcript becomes the cosine-guardrail-readable representation of the
 * binary content; the description gives the LLM context. Returns null if
 * the moderator extracted nothing useful (no transcript and a generic
 * description) — no point cluttering the prompt.
 */
function transcriptSiblingFor(
    verdict: ModerationResult,
    modality: "image" | "audio" | "video",
    filename: string | undefined,
): MediaPayload | null {
    const transcript = verdict.transcript.trim();
    const desc = verdict.description.trim();
    if (transcript === "" && desc === "") return null;
    const lines: string[] = [
        `[Moderator extract from attached ${modality}${filename ? ` "${filename}"` : ""} (provider: ${verdict.provider})]`,
    ];
    if (desc) lines.push(`Description: ${desc}`);
    if (transcript) lines.push(`Text content:`, transcript);
    return {
        kind: "text",
        mimeType: "text/plain",
        text: lines.join("\n"),
        sourceBytes: 0,
    };
}

function blockNoticePayload(
    modality: "image" | "audio" | "video",
    verdict: ModerationResult,
    filename: string | undefined,
): MediaPayload {
    const reason = verdict.failedClosed?.reason ?? verdict.reason ?? "unspecified";
    return {
        kind: "text",
        mimeType: "text/plain",
        text:
            `[BLOCKED ${modality} attachment${filename ? ` "${filename}"` : ""} — ` +
            `flagged by content moderator (provider=${verdict.provider}, ` +
            `confidence=${verdict.confidence.toFixed(2)}). Reason: ${reason}. ` +
            `Original content NOT forwarded to the agent.]`,
        sourceBytes: 0,
    };
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
