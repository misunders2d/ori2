#!/usr/bin/env node
/**
 * postinstall-prewarm — downloads the BGE-small-en-v1.5 ONNX model into
 * <project>/.cache/fastembed/ so the first chat message doesn't block on a
 * ~130MB download. Runs automatically via npm's `postinstall` hook.
 *
 * Skip mechanisms:
 *   FASTEMBED_SKIP_PREWARM=1  → skip entirely (CI, CD, offline installs)
 *   npm ci with --ignore-scripts also skips (node calls it "ignore-scripts")
 *
 * Fail-safe: a download failure does NOT kill the install — prints a warning
 * and exits 0. The bot will re-attempt the download on first chat (slower,
 * but functional). npm install stays green.
 *
 * Plain CommonJS / no TS transpile so it runs before tsx is wired.
 */
/* eslint-disable @typescript-eslint/no-var-requires */

const path = require("node:path");
const fs = require("node:fs");

async function main() {
    if (process.env.FASTEMBED_SKIP_PREWARM === "1" || process.env.FASTEMBED_SKIP_PREWARM === "true") {
        console.log("[prewarm] FASTEMBED_SKIP_PREWARM set — skipping fastembed model download.");
        return;
    }
    // Skip if the package is being installed as a dependency of something
    // else (npm sets `npm_config_global` or the INIT_CWD trick). When `ori2`
    // is a dev dep of a consumer project, we don't want to warm THEIR cache.
    // Heuristic: only warm if the closest package.json says name === "ori2".
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
        if (pkg.name !== "ori2") {
            console.log(`[prewarm] not inside ori2 (pkg name=${pkg.name}) — skipping.`);
            return;
        }
    } catch {
        // If package.json isn't here, we're not in the repo root.
        return;
    }

    const cacheDir = path.resolve(process.cwd(), ".cache", "fastembed");
    fs.mkdirSync(cacheDir, { recursive: true });

    let FlagEmbedding, EmbeddingModel;
    try {
        ({ FlagEmbedding, EmbeddingModel } = require("fastembed"));
    } catch (e) {
        console.warn(`[prewarm] fastembed not installed — skipping (install will succeed without prewarm). Err: ${e && e.message}`);
        return;
    }

    console.log(`[prewarm] warming BGE-small-en-v1.5 into ${cacheDir}`);
    console.log("[prewarm] first run downloads ~130MB; skip with FASTEMBED_SKIP_PREWARM=1");

    try {
        await FlagEmbedding.init({
            model: EmbeddingModel.BGESmallENV15,
            cacheDir,
            showDownloadProgress: true,
        });
        console.log("[prewarm] ✓ fastembed model ready");
    } catch (e) {
        console.warn(`[prewarm] download failed: ${e && e.message}`);
        console.warn("[prewarm] install continues; first chat will re-attempt.");
    }
}

main().catch((e) => {
    console.warn(`[prewarm] unexpected error: ${e && e.message}`);
    // Never fail the install.
    process.exit(0);
});
