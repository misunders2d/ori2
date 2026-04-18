import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";

// =============================================================================
// Loadability invariant for .pi/extensions/
//
// Pi's loader (node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/
// loader.js:231) does:
//
//   const module = await jiti.import(extensionPath, { default: true });
//   const factory = module;
//   if (typeof factory !== "function") {
//     return "Extension does not export a valid factory function";
//   }
//
// Any file in .pi/extensions/*.ts that doesn't satisfy "default export is a
// function" causes a noisy boot-time error. This bit us once when a `.test.ts`
// file ended up in the dir — node:test runner doesn't load files this way so
// the unit-test suite was happy while the bot crashed on boot.
//
// This test catches the class:
//   1. No *.test.ts files under .pi/extensions/ (tests live in src/, not next
//      to the extensions they exercise — Pi auto-loads everything here).
//   2. Every .ts file there has a default-exported function.
// =============================================================================

const EXT_DIR = path.resolve(process.cwd(), ".pi/extensions");

function listExtensionFiles(): string[] {
    if (!fs.existsSync(EXT_DIR)) return [];
    return fs.readdirSync(EXT_DIR)
        .filter((name) => name.endsWith(".ts"))
        .sort();
}

describe("Pi extension loadability — .pi/extensions/", () => {
    it("contains no *.test.ts files (Pi loads every .ts; tests must live in src/)", () => {
        const tests = listExtensionFiles().filter((n) => n.endsWith(".test.ts"));
        assert.deepEqual(
            tests,
            [],
            `Found .test.ts files inside .pi/extensions/: ${tests.join(", ")}. ` +
            `Move them to src/security/ or src/core/ — Pi's loader treats every .ts ` +
            `here as an extension factory and will error at boot on test files.`,
        );
    });

    // One sub-test per extension so a failure points at the offending file.
    for (const name of listExtensionFiles()) {
        if (name.endsWith(".test.ts")) continue; // covered by the assertion above
        it(`extension "${name}" exports a default factory function`, async () => {
            const abs = path.join(EXT_DIR, name);
            // Use the same .js suffix Pi's runtime uses (jiti resolves .ts).
            const importPath = abs.replace(/\.ts$/, ".js");
            let mod: { default?: unknown };
            try {
                mod = await import(importPath) as { default?: unknown };
            } catch (e) {
                throw new Error(
                    `Failed to import ${name}: ${e instanceof Error ? e.message : String(e)}. ` +
                    `Pi's boot-time loader will report "Extension does not export a valid factory function".`,
                );
            }
            assert.ok(
                mod.default !== undefined,
                `${name} has no default export. Pi requires \`export default function (pi) {...}\`.`,
            );
            assert.equal(
                typeof mod.default,
                "function",
                `${name}'s default export is ${typeof mod.default}, not a function. ` +
                `Pi requires the default to be a callable factory.`,
            );
            // Sanity: factory should accept at least one parameter (the
            // ExtensionAPI it's given). 0-arity factories almost certainly
            // forgot the parameter.
            const arity = (mod.default as (...args: unknown[]) => unknown).length;
            assert.ok(
                arity >= 1,
                `${name}'s factory has arity ${arity}. Pi calls it with one ExtensionAPI argument; arity 0 is almost certainly a mistake.`,
            );
        });
    }
});
