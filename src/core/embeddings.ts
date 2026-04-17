import path from "node:path";
import { EmbeddingModel, FlagEmbedding } from "fastembed";
import { ensureDir, sharedCacheDir } from "./paths.js";

// =============================================================================
// Shared local-embedding service.
//
// One FlagEmbedding (BGE-small-en-v1.5) ONNX session per process, reused by
// every consumer. Without this both guardrails AND memory would each load
// their own copy of the model into memory (~200MB each).
//
// On-disk model cache lives at <project>/.cache/fastembed/ — shared across
// every bot in the same checkout (the model is identical regardless of bot
// name) and across guardrails/memory within one process. `npm install` runs
// scripts/postinstall-prewarm.cjs which pre-downloads the ~130MB ONNX weights
// here so the first chat message isn't blocked on the download. Skip the
// prewarm with FASTEMBED_SKIP_PREWARM=1 at install time.
//
// Always returns plain `number[]`. fastembed's TypeScript types claim
// number[] but its runtime yields Float32Array, which JSON-serializes as
// `{"0": x, "1": y}` and silently breaks consumers that store + reload.
// We coerce to plain arrays at the boundary here so callers never have to
// think about this. Background: caught the hard way during Sprint 1.
// =============================================================================

export const EMBED_DIM = 384;
export const EMBED_MODEL_NAME = "fast-bge-small-en-v1.5";

let model: FlagEmbedding | null = null;
let initPromise: Promise<FlagEmbedding> | null = null;

async function getRawModel(): Promise<FlagEmbedding> {
    if (model) return model;
    if (initPromise) return initPromise;
    initPromise = (async () => {
        const cacheDir = path.join(sharedCacheDir(), "fastembed");
        ensureDir(cacheDir);
        const m = await FlagEmbedding.init({
            model: EmbeddingModel.BGESmallENV15,
            cacheDir,
            showDownloadProgress: true,
        });
        model = m;
        return m;
    })();
    return initPromise;
}

function toArray(v: unknown): number[] {
    if (Array.isArray(v)) return v as number[];
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
        return Array.from(v as unknown as ArrayLike<number>);
    }
    if (typeof v === "object" && v !== null) {
        const obj = v as Record<string, number>;
        const keys = Object.keys(obj);
        if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
            const out = new Array<number>(keys.length);
            for (const k of keys) out[Number(k)] = obj[k]!;
            return out;
        }
    }
    return [];
}

/** Embed multiple texts in batches. Yields plain number[][] (not Float32Array). */
export async function embedBatch(texts: string[], batchSize = 16): Promise<number[][]> {
    const m = await getRawModel();
    const out: number[][] = [];
    const gen = m.embed(texts, batchSize);
    for await (const batch of gen) {
        for (const v of batch) out.push(toArray(v));
    }
    return out;
}

/** Embed a single query. Yields a plain number[] (not Float32Array). */
export async function embedQuery(text: string): Promise<number[]> {
    const m = await getRawModel();
    const v = await m.queryEmbed(text);
    const arr = toArray(v);
    if (arr.length === 0) {
        throw new Error(`[embeddings] queryEmbed returned empty vector for input of length ${text.length}`);
    }
    return arr;
}

/** Cosine similarity. Both vectors must have the same length and be non-empty. */
export function cosineSim(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, ma = 0, mb = 0;
    for (let i = 0; i < a.length; i++) {
        const av = a[i]!;
        const bv = b[i]!;
        dot += av * bv;
        ma += av * av;
        mb += bv * bv;
    }
    const denom = Math.sqrt(ma) * Math.sqrt(mb);
    return denom === 0 ? 0 : dot / denom;
}

/** Pre-warm the model (e.g. from session_start) so first user-facing embed is instant. */
export async function preloadEmbedder(): Promise<void> {
    await getRawModel();
}
