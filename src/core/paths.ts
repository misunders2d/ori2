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
