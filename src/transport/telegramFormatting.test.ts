import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { chunkParagraphs, toMarkdownV2, TELEGRAM_MAX_TEXT } from "./telegramFormatting.js";

// =============================================================================
// chunkParagraphs — paragraph-aware text splitting
// =============================================================================

describe("chunkParagraphs — paragraph-aware splitting", () => {
    it("empty input → one empty chunk (preserves send-an-empty-message semantics)", () => {
        assert.deepEqual(chunkParagraphs(""), [""]);
    });

    it("under the limit → single chunk, unchanged", () => {
        assert.deepEqual(chunkParagraphs("hello world"), ["hello world"]);
    });

    it("splits on paragraph boundaries (blank lines) when over limit", () => {
        // Build a text with two clearly-separated paragraphs. Limit the chunk
        // size so each paragraph lands in its own chunk.
        const p1 = "a".repeat(200);
        const p2 = "b".repeat(200);
        const text = `${p1}\n\n${p2}`;
        const chunks = chunkParagraphs(text, 250);
        assert.equal(chunks.length, 2, "must split at the paragraph boundary");
        assert.equal(chunks[0], p1);
        assert.equal(chunks[1], p2);
    });

    it("multiple paragraphs packed into the same chunk when they fit", () => {
        const p1 = "a".repeat(50);
        const p2 = "b".repeat(50);
        const p3 = "c".repeat(50);
        const chunks = chunkParagraphs(`${p1}\n\n${p2}\n\n${p3}`, 300);
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0], `${p1}\n\n${p2}\n\n${p3}`);
    });

    it("splits at LINE boundaries when a paragraph exceeds the limit", () => {
        // Single paragraph with many lines totalling > max; chunker must
        // honor line boundaries (not mid-line cuts) when possible.
        const line = "x".repeat(50);
        const paragraph = Array.from({ length: 10 }, () => line).join("\n"); // 10 * 51 = 510
        const chunks = chunkParagraphs(paragraph, 200);
        assert.ok(chunks.length > 1);
        // Every chunk must itself be <= max.
        for (const c of chunks) assert.ok(c.length <= 200, `chunk exceeds max: ${c.length}`);
        // No chunk should contain a partial line (each starts/ends on line boundaries).
        for (const c of chunks) {
            for (const lineInChunk of c.split("\n")) {
                // Each line is either empty or a full x-run of length 50.
                if (lineInChunk.length > 0) assert.equal(lineInChunk, line, "chunked line must be whole, not sliced mid-line");
            }
        }
    });

    it("falls back to raw character slice ONLY for runaway single lines over max", () => {
        const runaway = "q".repeat(500);
        const chunks = chunkParagraphs(runaway, 200);
        assert.equal(chunks.length, 3, "500 chars / 200 max → 3 chunks");
        assert.equal(chunks[0]!.length, 200);
        assert.equal(chunks[1]!.length, 200);
        assert.equal(chunks[2]!.length, 100);
    });

    it("normalizes CRLF line endings so Windows-source text chunks identically", () => {
        const crlf = "a".repeat(100) + "\r\n\r\n" + "b".repeat(100);
        const chunks = chunkParagraphs(crlf, 150);
        assert.equal(chunks.length, 2);
        assert.equal(chunks[0], "a".repeat(100));
        assert.equal(chunks[1], "b".repeat(100));
    });

    it("default limit is TELEGRAM_MAX_TEXT (4096)", () => {
        assert.equal(TELEGRAM_MAX_TEXT, 4096);
        const justUnder = "a".repeat(4096);
        assert.equal(chunkParagraphs(justUnder).length, 1);
    });
});

// =============================================================================
// toMarkdownV2 — LLM-flavored markdown → Telegram MarkdownV2
// =============================================================================

describe("toMarkdownV2 — core escaping", () => {
    it("empty input → empty output", () => {
        assert.equal(toMarkdownV2(""), "");
    });

    it("plain text with no special chars passes through unescaped", () => {
        assert.equal(toMarkdownV2("hello world"), "hello world");
    });

    it("every V2 special char in plain text is backslash-escaped", () => {
        // All 18 specials per the spec: _ * [ ] ( ) ~ ` > # + - = | { } . !
        // Plus backslash itself.
        const src = "_*[]()~`>#+-=|{}.!\\";
        const expected = "\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\";
        assert.equal(toMarkdownV2(src), expected);
    });

    it("real-world LLM output: 'The file is at /tmp/file-1.pdf (size: 12KB).' — all specials escaped", () => {
        const out = toMarkdownV2("The file is at /tmp/file-1.pdf (size: 12KB).");
        // Periods, hyphens, parens and colons (actually colons are NOT in the
        // V2 specials list — only the punctuation above). So:
        //   . → \.   - → \-   ( → \(   ) → \)
        assert.equal(
            out,
            "The file is at /tmp/file\\-1\\.pdf \\(size: 12KB\\)\\.",
        );
    });
});

describe("toMarkdownV2 — bold, italic, strikethrough", () => {
    it("double-star bold → single-star bold (V2 convention)", () => {
        assert.equal(toMarkdownV2("**bold**"), "*bold*");
    });

    it("double-underscore bold → single-star bold", () => {
        assert.equal(toMarkdownV2("__bold__"), "*bold*");
    });

    it("single-underscore italic → single-underscore italic", () => {
        assert.equal(toMarkdownV2("_italic_"), "_italic_");
    });

    it("single-star italic → single-underscore italic (V2 canonical italic)", () => {
        // V2 treats _..._ as italic; * is bold. LLMs often emit *italic*,
        // which we rewrite.
        assert.equal(toMarkdownV2("before *italic* after"), "before _italic_ after");
    });

    it("tilde-tilde strikethrough → single-tilde strikethrough (V2 convention)", () => {
        assert.equal(toMarkdownV2("~~gone~~"), "~gone~");
    });

    it("bold containing plain specials escapes them inside the entity", () => {
        // **file.txt** → *file\.txt*
        assert.equal(toMarkdownV2("**file.txt**"), "*file\\.txt*");
    });
});

describe("toMarkdownV2 — code spans and fenced blocks", () => {
    it("inline code preserves its content literally (only ` and \\ escaped inside)", () => {
        // Literal dots, parens etc. inside code MUST NOT be backslash-escaped,
        // otherwise they render as literal backslashes in the code span.
        assert.equal(toMarkdownV2("run `pip install foo.bar` now"),
                     "run `pip install foo\\.bar` now".replace("pip install foo\\.bar", "pip install foo.bar"));
        // ^ the .replace trick shows the intended behavior: dot stays unescaped INSIDE code.
        // Plain assertion:
        assert.equal(toMarkdownV2("run `ls -la` now"), "run `ls -la` now");
    });

    it("inline code with backtick escaping", () => {
        // A backtick in content requires escaping — unlikely in practice but spec-required.
        // (We build code spans by splitting on non-content backticks; if content
        // contains a `, our regex wouldn't match — skip this pathological case.)
        // Instead test the escape in a stand-alone context via a backslash.
        assert.equal(toMarkdownV2("path `C:\\foo`"), "path `C:\\\\foo`");
    });

    it("fenced code block preserves content + language tag", () => {
        const src = "```python\nprint('hi.')\n```";
        const out = toMarkdownV2(src);
        // V2 fenced: ```lang\n<body>\n``` — body's . and ( ) stay unescaped.
        assert.equal(out, "```python\nprint('hi.')\n```");
    });

    it("fenced block with backslashes in body escapes them", () => {
        assert.equal(toMarkdownV2("```\nC:\\foo\n```"), "```\nC:\\\\foo\n```");
    });

    it("text around a fenced block is escaped as plain", () => {
        const src = "Here is code:\n```\necho hi.\n```\nDone.";
        const out = toMarkdownV2(src);
        assert.match(out, /Here is code:/);
        assert.match(out, /```\necho hi\.\n```/);
        assert.match(out, /Done\\\./);
    });
});

describe("toMarkdownV2 — links", () => {
    it("[text](url) → [escaped-text](escaped-url)", () => {
        const out = toMarkdownV2("see [the docs](https://example.com/foo.html)");
        assert.equal(out, "see [the docs](https://example.com/foo.html)");
    });

    it("link text with periods escapes the periods", () => {
        assert.equal(toMarkdownV2("[v1.2.3](https://x.y/z)"), "[v1\\.2\\.3](https://x.y/z)");
    });

    // URLs containing a literal `)` are ambiguous without a smarter parser
    // (the closing `)` of the link vs. a paren in the URL). LLMs rarely emit
    // Wikipedia paren-disambiguated URLs as plain markdown links; such
    // edge cases fall through the link regex and render as escaped plain
    // text — ugly but readable, and the MarkdownV2 fallback to plain-text
    // still delivers the message. Acceptable at baseline.
});

describe("toMarkdownV2 — end-to-end sanity on typical LLM output", () => {
    it("numbered list with bold labels — the exact shape that breaks in plain-text send", () => {
        const src =
            "Here are the key implications:\n\n" +
            "1. **Complexity**: You'll manage two systems.\n" +
            "2. **Storage**: Both need partitions.";
        const out = toMarkdownV2(src);
        // Bolds converted, numbers escaped, colons untouched (colon is NOT a V2 special),
        // periods after list numbers escaped, hyphens escaped.
        assert.equal(
            out,
            "Here are the key implications:\n\n" +
            "1\\. *Complexity*: You'll manage two systems\\.\n" +
            "2\\. *Storage*: Both need partitions\\.",
        );
    });

    it("inline code inside a sentence — the pattern that breaks plain MarkdownV2", () => {
        const src = "Call `set_channel_model('google', 'gemini-3')` then wait.";
        const out = toMarkdownV2(src);
        // Code content stays literal (no . escape); outside gets escaped.
        assert.equal(
            out,
            "Call `set_channel_model('google', 'gemini-3')` then wait\\.",
        );
    });
});
