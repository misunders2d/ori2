import fs from "node:fs";
import path from "node:path";

// Single source of truth for bot identity and per-bot data paths.
// All extensions and core code MUST read BOT_NAME and per-bot paths through
// these helpers — direct `process.env.BOT_NAME ?? "..."` access scattered
// across files leads to inconsistent defaults and silent data-dir mismatch.

export const DEFAULT_BOT_NAME = "ori2_agent";

export function getBotName(): string {
    const raw = process.env["BOT_NAME"];
    if (!raw || raw.trim() === "") return DEFAULT_BOT_NAME;
    return raw.trim();
}

export function botDir(): string {
    return path.resolve(process.cwd(), "data", getBotName());
}

export function botSubdir(name: string): string {
    return path.join(botDir(), name);
}

export function ensureDir(p: string): void {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// Shared, NOT per-bot: same checkout's bots can share artefacts that don't
// change per-bot (e.g. the fastembed ONNX model cache — always the same file
// regardless of bot name). Lives outside data/ so `rm -rf data/<bot>` never
// purges the model, and so a single `npm install` postinstall can warm it
// before any bot name is chosen.
export function sharedCacheDir(): string {
    return path.resolve(process.cwd(), ".cache");
}
