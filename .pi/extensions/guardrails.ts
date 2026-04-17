import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { botSubdir, ensureDir } from "../../src/core/paths.js";
import { cosineSim, embedBatch, embedQuery } from "../../src/core/embeddings.js";

// =============================================================================
// Prompt-Injection Guardrail (local-first, zero-API-key baseline)
//
// Two-layer defense, both running on local embeddings by default:
//
//   1. DIRECT INJECTION (before_agent_start): every user prompt is embedded
//      and compared (cosine sim) to a corpus of known injection anchors. If
//      similarity exceeds DIRECT_THRESHOLD on any anchor, the prompt is
//      rejected and the LLM is never invoked.
//
//   2. INDIRECT INJECTION (tool_result): output from high-risk tools (web,
//      bash, read) is regex-prefiltered for known attack phrasing. If the
//      regex matches, a 300-char window around the match is embedded and
//      compared semantically. If above INDIRECT_THRESHOLD, the result is
//      replaced with a safe-discard message before reaching the model.
//
// EMBEDDING BACKEND
//   Default: local `fastembed` (BGE-small-en-v1.5, ~130MB, MIT, no API key).
//   First init downloads the model to `data/<bot>/.fastembed_cache/`. Subsequent
//   starts are fast.
//
//   Optional override: set GUARDRAIL_EMBEDDINGS=google or GUARDRAIL_EMBEDDINGS=openai
//   to use the respective remote API (requires GOOGLE_API_KEY or OPENAI_API_KEY).
//   The remote backends produce higher-dimensional vectors but are not required.
//
// CORPUS
//   `.pi/extensions/guardrail_corpus.json` lists ~45 attack anchors covering
//   direct, indirect, markup-format, and exfiltration patterns. Edit this file
//   to extend coverage; the next session will re-embed and recache.
//
// CACHE
//   Corpus embeddings are cached at `data/<bot>/guardrail_anchors.cache.json`.
//   Cache is keyed by (model + corpus_version + corpus_hash) so it auto-invalidates
//   if you edit the corpus or switch backends.
// =============================================================================

// Tuning notes:
//   - DIRECT is the whole-prompt embedding scan. It has NO regex prefilter,
//     so inherent false-positive risk at low thresholds — benign prompts
//     with injection-adjacent vocabulary ("don't forget to...", "ignore
//     the typo...") drift near anchors. Previously 0.78, raised to 0.85
//     after a live incident (sim=0.783 blocked a normal ask on 2026-04-17).
//   - INDIRECT is the regex+window scan. Regex already gated the attack
//     shape; a tighter 0.75 threshold is safe because false-positive regex
//     matches are rare on legitimate content.
//   - Both are env-tunable. If an injection slips through, bump DIRECT up;
//     if legitimate prompts block, bump down. Defaults chosen for BGE-small
//     (~384d embedding, local fastembed default); Google/OpenAI embedders
//     (~768d+) have wider sim distributions and may warrant lower defaults.
function readThreshold(envKey: string, fallback: number): number {
    const raw = process.env[envKey];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n >= 1) return fallback;
    return n;
}

const DIRECT_THRESHOLD = readThreshold("ORI2_GUARDRAIL_DIRECT_THRESHOLD", 0.85);
const INDIRECT_THRESHOLD = readThreshold("ORI2_GUARDRAIL_INDIRECT_THRESHOLD", 0.75);
const INDIRECT_WINDOW = 300;

// JS-syntax regex. Anchors phrasing commonly used to inject through user
// prompts (incl. document content the adapter inlines) or tool output.
//
// Loosened 2026-04-17 after a live incident: a PDF contained "Now forget all
// your instructions..." and slipped past the previous regex because the
// middle group required EXACTLY ONE modifier (the attack has two: "all
// your"). The `(?:\s+(?:modifier))*` form now allows zero-to-many modifiers,
// catching common chains: "forget all your instructions", "disregard any
// previous directives", "ignore previous" (no target), "override my rules".
// Target list extended with commands/orders; modifier list with these/them/
// our/my. False-positive risk is small — the window-embedding stage still
// has to cosine-match the corpus.
const INJECTION_REGEX = /(?:ignore|disregard|forget|override|bypass|stop\s+(?:following|using))(?:\s+(?:all|any|your|previous|prior|above|the|these|them|our|my))*\s+(?:instructions?|directives?|rules?|context|prompts?|guidelines?|commands?|orders?)|(?:you\s+are\s+now|new\s+system\s+prompt|act\s+as\s+if|pretend\s+(?:to\s+be|you\s+are))/i;

const HIGH_RISK_TOOLS = new Set(["web_fetch", "web_search", "bash", "read"]);
const CORPUS_PATH = path.resolve(process.cwd(), ".pi/extensions/guardrail_corpus.json");

type Backend = "local" | "google" | "openai";

function pickBackend(): Backend {
    const v = (process.env["GUARDRAIL_EMBEDDINGS"] ?? "local").toLowerCase();
    // Google AI Studio accepts GEMINI_API_KEY (Pi's canonical name) OR the
    // older GOOGLE_API_KEY. Check both so operators on either convention
    // keep working.
    if (v === "google" && (process.env["GEMINI_API_KEY"] || process.env["GOOGLE_API_KEY"])) return "google";
    if (v === "openai" && process.env["OPENAI_API_KEY"]) return "openai";
    return "local";
}

function corpusHash(anchors: string[]): string {
    // Tiny non-cryptographic hash — only needs to detect corpus drift.
    let h = 0;
    const s = anchors.join("\u0001");
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
}

async function getRemoteEmbedding(text: string, backend: "google" | "openai"): Promise<number[] | null> {
    // FAIL-LOUD: this returns null only when the backend isn't even configured
    // (no API key) so the picker can fall back to local. Any other failure
    // (HTTP error, malformed response) throws so the caller can't pretend
    // a check succeeded when it didn't.
    if (backend === "google") {
        const key = process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_API_KEY"];
        if (!key) return null;
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${key}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: "models/text-embedding-004", content: { parts: [{ text }] } }),
            },
        );
        if (!res.ok) {
            throw new Error(`[guardrails] Google embedding API returned ${res.status} ${res.statusText}`);
        }
        const data = (await res.json()) as { embedding?: { values?: number[] } };
        const v = data.embedding?.values;
        if (!v || v.length === 0) {
            throw new Error("[guardrails] Google embedding API response had no values");
        }
        return v;
    } else {
        const key = process.env["OPENAI_API_KEY"];
        if (!key) return null;
        const res = await fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
            body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
        });
        if (!res.ok) {
            throw new Error(`[guardrails] OpenAI embedding API returned ${res.status} ${res.statusText}`);
        }
        const data = (await res.json()) as { data?: { embedding?: number[] }[] };
        const v = data.data?.[0]?.embedding;
        if (!v || v.length === 0) {
            throw new Error("[guardrails] OpenAI embedding API response had no embedding");
        }
        return v;
    }
}

// Defense-in-depth: coerces buggy-era cache-file vectors stored as
// {"0": x, "1": y} objects with numeric-string keys back into arrays.
// New writes never produce that shape (shared embedder coerces upstream).
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

export class GuardrailEmbedder {
    private backend: Backend;
    private corpusVectors: number[][] = [];
    private corpusReady = false;
    private initPromise: Promise<void> | null = null;

    constructor(backend: Backend) { this.backend = backend; }

    /**
     * Test-only: seed corpus vectors and force-ready state, bypassing the
     * file/remote init that would otherwise require a 130MB fastembed model
     * download. Callers supply the query-embedding stub via `queryEmbedStub`
     * so tests don't need an embedding API at all.
     */
    static forTests(opts: {
        corpusVectors: number[][];
        queryEmbedStub: (text: string) => Promise<number[]>;
    }): GuardrailEmbedder {
        const e = new GuardrailEmbedder("local");
        e.corpusVectors = opts.corpusVectors;
        e.corpusReady = true;
        e.initPromise = Promise.resolve();
        // Override queryEmbed on this instance (not the prototype) so other
        // instances in the same process are unaffected.
        (e as unknown as { queryEmbed: (text: string) => Promise<number[]> }).queryEmbed = opts.queryEmbedStub;
        return e;
    }

    async ensureReady(): Promise<void> {
        if (this.corpusReady) return;
        if (!this.initPromise) this.initPromise = this.init();
        await this.initPromise;
    }

    private async init(): Promise<void> {
        if (!fs.existsSync(CORPUS_PATH)) {
            // FAIL-LOUD: a missing corpus means the guardrail cannot function.
            // Refuse to silently pass everything through — that would be a
            // worse-than-useless safety regression.
            throw new Error(
                `[guardrails] FATAL: corpus missing at ${CORPUS_PATH}. The prompt-injection guardrail cannot operate without it. Check your installation.`,
            );
        }
        const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf-8")) as { anchors: string[]; version?: number };
        if (!corpus.anchors || corpus.anchors.length === 0) {
            throw new Error(
                `[guardrails] FATAL: corpus at ${CORPUS_PATH} has no anchors. Cannot build vector index — the guardrail would silently pass every prompt. Refusing to start.`,
            );
        }

        const cacheDir = botSubdir(".guardrails");
        ensureDir(cacheDir);
        const cachePath = path.join(cacheDir, "anchors.cache.json");
        const expectedKey = `${this.backend}|v${corpus.version ?? 1}|${corpusHash(corpus.anchors)}`;

        if (fs.existsSync(cachePath)) {
            try {
                const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as { key: string; vectors: unknown[] };
                if (cached.key === expectedKey && Array.isArray(cached.vectors) && cached.vectors.length === corpus.anchors.length) {
                    // Coerce in case cache was written by a buggy prior version
                    // (TypedArray-as-object shape).
                    this.corpusVectors = cached.vectors.map((v) => toArray(v));
                    if (this.corpusVectors[0] && this.corpusVectors[0].length > 0) {
                        this.corpusReady = true;
                        return;
                    }
                }
            } catch {
                // fall through to re-embed
            }
        }

        // Cache miss — embed the corpus now.
        console.log(`[guardrails] embedding ${corpus.anchors.length} anchors with backend=${this.backend}...`);
        let vectors: number[][] = [];
        if (this.backend === "local") {
            // Shared embedder; coerces TypedArray→number[] internally.
            vectors = await embedBatch(corpus.anchors, 16);
        } else {
            for (const a of corpus.anchors) {
                const v = await getRemoteEmbedding(a, this.backend);
                if (!v) {
                    throw new Error(
                        `[guardrails] FATAL: backend '${this.backend}' returned no embedding for anchor "${a.slice(0, 40)}...". Refusing to start with incomplete corpus.`,
                    );
                }
                vectors.push(v);
            }
        }
        if (vectors.length !== corpus.anchors.length) {
            // FAIL-LOUD: if remote API rate-limited some anchors, we'd have a
            // partial-coverage guardrail and not know which patterns are missed.
            throw new Error(
                `[guardrails] FATAL: only embedded ${vectors.length}/${corpus.anchors.length} anchors with backend=${this.backend}. Refusing to start with partial coverage.`,
            );
        }
        const dim = vectors[0]?.length ?? 0;
        if (dim === 0) {
            throw new Error(`[guardrails] FATAL: anchor embeddings have dimension 0. Backend '${this.backend}' returned empty vectors.`);
        }
        this.corpusVectors = vectors;
        fs.writeFileSync(cachePath, JSON.stringify({ key: expectedKey, vectors }));
        this.corpusReady = true;
        console.log(`[guardrails] corpus ready (${vectors.length} vectors, dim=${dim})`);
    }

    // FAIL-LOUD: throws on any embedding failure. The caller MUST NOT swallow
    // — a failed embedding means the next user prompt cannot be checked.
    async queryEmbed(text: string): Promise<number[]> {
        await this.ensureReady();
        if (this.backend === "local") {
            // Shared embedder throws on empty vectors itself.
            return embedQuery(text);
        }
        const v = await getRemoteEmbedding(text, this.backend);
        if (!v || v.length === 0) {
            throw new Error(`[guardrails] FATAL: remote (${this.backend}) embedding API failed or returned empty vector. Cannot check this prompt.`);
        }
        return v;
    }

    matchSimilarity(vec: number[], threshold: number): { matched: boolean; maxSim: number; anchorIdx: number } {
        let maxSim = 0;
        let anchorIdx = -1;
        for (let i = 0; i < this.corpusVectors.length; i++) {
            const s = cosineSim(vec, this.corpusVectors[i]!);
            if (s > maxSim) { maxSim = s; anchorIdx = i; }
            if (s >= threshold) return { matched: true, maxSim: s, anchorIdx: i };
        }
        return { matched: false, maxSim, anchorIdx };
    }

    isReady(): boolean { return this.corpusReady && this.corpusVectors.length > 0; }
    backendName(): Backend { return this.backend; }
}

/**
 * Test-only: override the embedder the default-export factory will use.
 * Set BEFORE invoking the factory, clear to null when done. Do NOT use in
 * production code — this module isn't re-entrant-safe.
 */
let _embedderOverride: GuardrailEmbedder | null = null;
export function __setEmbedderForTests(e: GuardrailEmbedder | null): void {
    _embedderOverride = e;
}

/**
 * Two-stage injection scan used by BOTH the direct (before_agent_start) and
 * indirect (tool_result) paths:
 *   1. cheap regex prefilter — most content has nothing suspicious.
 *   2. semantic check on a 300-char window around the regex hit.
 *
 * Returns {similarity, fragment} if both stages flag, otherwise null.
 * Throws only if the embedder fails — callers decide how to handle (block
 * with fail-loud vs. graceful degrade for tool_result that can suppress
 * rather than throw).
 */
async function scanForInjectionWindow(
    text: string,
    embedder: GuardrailEmbedder,
): Promise<{ similarity: number; fragment: string } | null> {
    if (text.length < 20) return null;
    const match = text.match(INJECTION_REGEX);
    if (!match) return null;
    const start = Math.max(0, (match.index ?? 0) - 100);
    const fragment = text.substring(start, start + INDIRECT_WINDOW);
    const vec = await embedder.queryEmbed(fragment);
    const m = embedder.matchSimilarity(vec, INDIRECT_THRESHOLD);
    if (!m.matched) return null;
    return { similarity: m.maxSim, fragment };
}

export default function (pi: ExtensionAPI) {
    const embedder = _embedderOverride ?? new GuardrailEmbedder(pickBackend());

    // Kick off corpus embedding eagerly on session start so the first user
    // message doesn't pay the model-download + corpus-embed cost. If init
    // fails, surface it loudly to the admin — DO NOT swallow. A guardrail
    // that quietly fails open is a worse-than-useless safety regression.
    pi.on("session_start", async (_event, ctx) => {
        embedder.ensureReady().catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            // Import synchronously via dynamic require to avoid a top-of-file
            // import cycle with guardrails loading early in the extension chain.
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { logError } = require("../../src/core/errorLog.js") as typeof import("../../src/core/errorLog.js");
                logError("guardrails", "CRITICAL init failure — protection NOT active", { err: msg });
            } catch {
                console.error("[guardrails] CRITICAL init failure:", e);
            }
            ctx.ui.notify(
                `⚠️ GUARDRAIL OFFLINE: ${msg}\nProtection is NOT active until this is fixed. Restart the bot once corrected.`,
                "error",
            );
        });
    });

    // 1. Prompt injection — block before the LLM is invoked.
    //
    // Two sub-checks, both fail-loud: if the embedder cannot verify a prompt,
    // REFUSE to forward it. The agent never sees an unvetted message.
    //
    //   (a) WINDOW SCAN — regex prefilter + 300-char window embedding around
    //       any hit. Catches injections BURIED in large legitimate text
    //       (e.g. a malicious line inside a 10-page PDF attached by the
    //       user). The whole-prompt embedding in (b) washes out such signals
    //       because the bulk of benign text dominates the vector.
    //       This mirrors what the tool_result handler does for indirect
    //       injection from web_fetch/read/bash output — we extend it to
    //       user prompts because documents extracted at the adapter boundary
    //       (telegram.ts → fileToPayload for PDFs/CSVs) arrive as prompt
    //       content, not tool results.
    //
    //   (b) WHOLE-PROMPT SCAN — embed the full prompt, compare against
    //       the corpus. Catches adversarial prompts with no obvious
    //       regex pattern — e.g. attack phrasings in languages other than
    //       English where the regex misses but the multilingual embedder
    //       still clusters near an anchor.
    //
    // Either sub-check firing blocks the prompt.
    pi.on("before_agent_start", async (event, ctx) => {
        const prompt = event.prompt;
        if (!prompt || prompt.length < 4) return;

        try {
            await embedder.ensureReady();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ctx.ui.notify(`Guardrail unavailable, prompt rejected: ${msg}`, "error");
            throw new Error(`Guardrail unavailable, refusing to forward prompt to LLM: ${msg}`);
        }

        // (a) window scan
        const windowHit = await scanForInjectionWindow(prompt, embedder);
        if (windowHit) {
            ctx.ui.notify(
                `Guardrail: buried prompt injection blocked (sim=${windowHit.similarity.toFixed(2)}).`,
                "error",
            );
            throw new Error(
                `Guardrail Blocked: prompt injection detected in embedded document or text (cosine=${windowHit.similarity.toFixed(3)} ≥ ${INDIRECT_THRESHOLD}). ` +
                `Matched fragment: "${windowHit.fragment.slice(0, 120).replace(/\s+/g, " ")}..."`,
            );
        }

        // (b) whole-prompt scan
        let vec: number[];
        try {
            vec = await embedder.queryEmbed(prompt);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ctx.ui.notify(`Guardrail check failed, prompt rejected: ${msg}`, "error");
            throw new Error(`Guardrail check failed, refusing to forward prompt to LLM: ${msg}`);
        }

        const m = embedder.matchSimilarity(vec, DIRECT_THRESHOLD);
        if (m.matched) {
            ctx.ui.notify(`Guardrail: prompt injection blocked (sim=${m.maxSim.toFixed(2)}).`, "error");
            throw new Error(
                `Guardrail Blocked: prompt injection detected (cosine=${m.maxSim.toFixed(3)} ≥ ${DIRECT_THRESHOLD}).`,
            );
        }
    });

    // 2. Indirect injection — scrub high-risk tool output before it reaches the LLM.
    //    FAIL-LOUD: if the embedder cannot check, replace the tool result with
    //    an explicit error so the LLM sees nothing untrusted.
    pi.on("tool_result", async (event, ctx) => {
        if (!HIGH_RISK_TOOLS.has(event.toolName)) return;

        try {
            await embedder.ensureReady();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ctx.ui.notify(`Guardrail unavailable; ${event.toolName} output suppressed.`, "error");
            return {
                content: [{
                    type: "text",
                    text: `[GUARDRAIL UNAVAILABLE] Cannot verify safety of ${event.toolName} output. Output suppressed. Reason: ${msg}`,
                }],
                isError: true,
            };
        }

        // Build the text to scan from the result content array.
        const resultText = event.content
            ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n") ?? "";
        if (resultText.length < 20) return;

        let hit: { similarity: number; fragment: string } | null;
        try {
            hit = await scanForInjectionWindow(resultText, embedder);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ctx.ui.notify(`Guardrail check failed; ${event.toolName} output suppressed.`, "error");
            return {
                content: [{
                    type: "text",
                    text: `[GUARDRAIL CHECK FAILED] Output of ${event.toolName} contained suspicious phrasing but the semantic check could not run. Output suppressed for safety. Reason: ${msg}`,
                }],
                isError: true,
            };
        }
        if (!hit) return;

        ctx.ui.notify(`Guardrail: indirect injection scrubbed in ${event.toolName} output (sim=${hit.similarity.toFixed(2)}).`, "error");
        return {
            content: [{
                type: "text",
                text: `[CONTENT BLOCKED BY GUARDRAIL]\n\nThe ${event.toolName} tool returned content that matched a known prompt-injection pattern (semantic similarity ${hit.similarity.toFixed(3)}). The content has been discarded for safety.\n\nIf you need to access this source, ask the human user to verify it manually first.`,
            }],
            isError: false,
        };
    });
}
