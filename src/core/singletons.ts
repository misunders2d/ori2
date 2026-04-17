// =============================================================================
// Cross-module-graph singleton registry.
//
// Why this exists:
//   Pi loads `.pi/extensions/*.ts` via `@mariozechner/jiti` (see
//   node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/loader.js).
//   jiti maintains its OWN module cache, separate from Node's native ESM
//   loader (tsx, used for `npm start`). When the main bootstrap
//   (src/index.ts, loaded by tsx) and a Pi extension (loaded by jiti)
//   both import `src/transport/dispatcher.js`, they each get their own
//   module instance with independent `let _instance: X | null = null`
//   state. Result: `src/index.ts` registers adapters on dispatcher A;
//   the `/health` extension reads from dispatcher B; both are "empty
//   but different" from each other's POV.
//
//   Same bug affects every singleton we export via `getXxx()` or
//   `ClassName.instance()`. Observed symptom: `/health` reports
//   "no transport adapters registered" despite the boot log showing
//   all three registered.
//
// Fix: stash the singleton on `globalThis` under a well-known key. Both
// module graphs see the same global object, so both `getOrCreate(...)`
// calls return the same instance. This is the standard cross-loader
// state-sharing pattern — see how React handles `useState` across
// duplicated React modules, etc.
//
// Cost: ~one WeakMap lookup per getter. Measured negligible.
//
// How to use (all singleton getters):
//
//     import { getOrCreate } from "./singletons.js";
//     export function getVault(): Vault {
//         return getOrCreate("vault", () => new Vault());
//     }
//
// The string key must be unique across the entire project. Prefix with
// the module name if in doubt.
// =============================================================================

interface Registry {
    [key: string]: unknown;
}

const GLOBAL_KEY = "__ori2_singletons_v1__";
const G = globalThis as typeof globalThis & { [GLOBAL_KEY]?: Registry };

function registry(): Registry {
    if (!G[GLOBAL_KEY]) G[GLOBAL_KEY] = Object.create(null) as Registry;
    return G[GLOBAL_KEY]!;
}

/**
 * Get-or-create a singleton shared across all module graphs in this process.
 * Use for classes that MUST have one instance per process regardless of how
 * many times their module is loaded (Pi's jiti + tsx double-loading problem).
 */
export function getOrCreate<T>(key: string, factory: () => T): T {
    const r = registry();
    if (r[key] === undefined) r[key] = factory();
    return r[key] as T;
}

/**
 * Set a singleton explicitly (for handles populated by callers, not factories).
 * Example: `setSingleton("a2a.serverHandle", handleFromStartA2AServer(...))`.
 */
export function setSingleton<T>(key: string, value: T | null): void {
    const r = registry();
    if (value === null) delete r[key];
    else r[key] = value;
}

/**
 * Read a singleton without creating it. Returns undefined if not set.
 */
export function getSingleton<T>(key: string): T | undefined {
    return registry()[key] as T | undefined;
}

/**
 * Test-only — clears the entire registry. Individual tests that need a
 * fresh singleton instance should still use the module's own `reset()`
 * method where available (that also drops in-memory state the factory
 * would otherwise restore from disk).
 */
export function clearRegistryForTests(): void {
    delete G[GLOBAL_KEY];
}
