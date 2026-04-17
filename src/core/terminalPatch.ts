// Workaround for @mariozechner/pi-tui releasing kitty-keyboard release events
// into the input field as visible CSI-u text.
//
// pi-tui (dist/terminal.js:91) enables the kitty keyboard protocol by writing
// `CSI > 7 u` — flags 1|2|4:
//   1 = disambiguate escape codes
//   2 = report event types  (press / repeat / RELEASE)
//   4 = report alternate keys
//
// The TUI consumes press events correctly, but in some terminal + render
// loop combinations the release events fall through to the active text
// editor and are rendered as literal `\e[<code>;<mod>:3u` strings. 5-year-old
// users see garbled input and can't tell what's wrong.
//
// We intercept process.stdout.write at process entry and rewrite the enable
// sequence on the wire to `CSI > 5 u` (flags 1|4 — drop event-type reporting).
// press-only is the sane default for a chat TUI; no functional regression.
//
// DELETE THIS PATCH when pi-tui ships a fix for the release-event leak.
// Tracked informally: open an issue against @mariozechner/pi-tui if it
// doesn't already exist.
//
// Implementation notes:
// - Must be imported as a side-effect BEFORE any pi-coding-agent imports so
//   the patched write is already in place when the TUI activates.
// - String and Buffer paths both covered (pi-tui uses string writes today,
//   but Node's TTYWrap path can deliver Buffer depending on encoding).
// - Stable regex reference: the sequence is 4 bytes — literal ESC [ > 7 u.

const SEARCH = "\x1b[>7u";
const REPLACE = "\x1b[>5u";

const origWrite = process.stdout.write.bind(process.stdout);

function rewritePayload(chunk: string | Uint8Array): string | Uint8Array {
    if (typeof chunk === "string") {
        return chunk.includes(SEARCH) ? chunk.split(SEARCH).join(REPLACE) : chunk;
    }
    if (Buffer.isBuffer(chunk) && chunk.indexOf(SEARCH) !== -1) {
        const rewritten = chunk.toString("binary").split(SEARCH).join(REPLACE);
        return Buffer.from(rewritten, "binary");
    }
    return chunk;
}

// Match all three overloads of WriteStream.write:
//   write(chunk)
//   write(chunk, cb?)
//   write(chunk, encoding, cb?)
// Keep the signature loose — Node's types here are three overloads we don't
// want to fight.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process.stdout as any).write = function patchedWrite(this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]): boolean {
    if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
        chunk = rewritePayload(chunk as string | Uint8Array);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origWrite as any).call(this, chunk, ...rest);
};
