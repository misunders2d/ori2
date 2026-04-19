// =============================================================================
// Telegram-specific text formatting: paragraph-aware chunking + MarkdownV2
// conversion.
//
// Two responsibilities, both pure (no I/O, no Telegram client):
//
//   chunkParagraphs(text, max=4096)
//     Splits text at PARAGRAPH boundaries first (blank-line separated), then
//     at LINE boundaries if a paragraph is still too big, then at raw
//     character boundaries as a last resort. Adapted from pi-telegram
//     (Mario Zechner's reference bridge, github.com/badlogic/pi-telegram,
//     chunkParagraphs function — load-bearing pattern for readability).
//
//     Why not a naive slice: LLM output has structure (bullet lists, code
//     blocks, headings). A mid-word cut at char 4096 produces visually
//     broken messages; a mid-code-fence cut would break MarkdownV2 parsing
//     of the next chunk entirely. Honor the smallest paragraph boundary
//     that satisfies the limit.
//
//   toMarkdownV2(text)
//     Converts LLM-flavored markdown (** for bold, `...` / ```...``` for
//     code, [text](url) for links) into Telegram MarkdownV2 and escapes
//     literal special characters everywhere else. Fail-safe: if the input
//     is safe to send as MarkdownV2, the output is a valid V2 string Pi's
//     send() can pass to parse_mode:"MarkdownV2". If Telegram still rejects
//     it (the spec is notoriously strict), the adapter's send() catches
//     the 400 and retries as plain text — the user ALWAYS sees the message.
//
// MarkdownV2 spec (core.telegram.org/bots/api#markdownv2-style):
//   - Outside entities, these MUST be escaped with backslash:
//     _ * [ ] ( ) ~ ` > # + - = | { } . !
//   - Inside code and pre: only backtick and backslash need escaping
//   - Inside link URL ([text](URL)): only ) and backslash need escaping
//   - Italic: _..._   Bold: *...*   Code: `...`   Pre: ```...```
//     Link: [text](url)   Strikethrough: ~...~
// =============================================================================

export const TELEGRAM_MAX_TEXT = 4096;

// ---------------- chunking ----------------

/**
 * Split `text` into pieces each <= `max` (default 4096). Prefers paragraph
 * boundaries (blank lines), falls back to single-line boundaries, then to
 * hard character cuts only for runaway single lines.
 */
export function chunkParagraphs(text: string, max: number = TELEGRAM_MAX_TEXT): string[] {
    if (text.length === 0) return [""];
    if (text.length <= max) return [text];

    const normalized = text.replace(/\r\n/g, "\n");
    const paragraphs = normalized.split(/\n\n+/);
    const chunks: string[] = [];
    let current = "";

    const flushCurrent = (): void => {
        if (current.trim().length > 0) chunks.push(current);
        current = "";
    };

    const splitLongBlock = (block: string): string[] => {
        if (block.length <= max) return [block];
        const lines = block.split("\n");
        const out: string[] = [];
        let lineCurrent = "";
        for (const line of lines) {
            const candidate = lineCurrent.length === 0 ? line : `${lineCurrent}\n${line}`;
            if (candidate.length <= max) { lineCurrent = candidate; continue; }
            if (lineCurrent.length > 0) { out.push(lineCurrent); lineCurrent = ""; }
            if (line.length <= max) { lineCurrent = line; continue; }
            // Runaway line — slice by chars as the last resort.
            for (let i = 0; i < line.length; i += max) {
                out.push(line.slice(i, i + max));
            }
        }
        if (lineCurrent.length > 0) out.push(lineCurrent);
        return out;
    };

    for (const paragraph of paragraphs) {
        if (paragraph.length === 0) continue;
        for (const part of splitLongBlock(paragraph)) {
            const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
            if (candidate.length <= max) current = candidate;
            else { flushCurrent(); current = part; }
        }
    }
    flushCurrent();
    return chunks;
}

// ---------------- MarkdownV2 conversion ----------------

const V2_SPECIAL = /[_*\[\]()~`>#+\-=|{}.!\\]/g;
const V2_CODE_SPECIAL = /[`\\]/g;
const V2_URL_SPECIAL = /[)\\]/g;

function escapePlain(s: string): string { return s.replace(V2_SPECIAL, "\\$&"); }
function escapeCode(s: string): string { return s.replace(V2_CODE_SPECIAL, "\\$&"); }
function escapeUrl(s: string): string { return s.replace(V2_URL_SPECIAL, "\\$&"); }

interface Token {
    type: "pre" | "code" | "link" | "bold" | "italic" | "strike" | "plain";
    body: string;
    lang?: string;
    url?: string;
}

/**
 * Convert LLM-flavored markdown to Telegram MarkdownV2.
 *
 * Handles common patterns emitted by LLMs:
 *   triple-backtick code fences, single-backtick inline code, double-star
 *   bold, single-star / underscore italic, tilde-tilde strikethrough,
 *   [text](url) links. Everything else is plain text with every V2 special
 *   char backslash-escaped.
 */
export function toMarkdownV2(input: string): string {
    if (input.length === 0) return "";

    const FENCE_RE = /```([a-zA-Z0-9_+\-]*)\n?([\s\S]*?)```/g;
    const INLINE_CODE_RE = /`([^`\n]+?)`/g;
    const LINK_RE = /\[([^\]\n]+?)\]\(([^)\n\s]+?)\)/g;
    const BOLD_RE = /(\*\*|__)([^*_\n]+?)\1/g;
    const STRIKE_RE = /~~([^~\n]+?)~~/g;
    const ITALIC_RE = /(?:^|[^*_])([*_])([^*_\n]+?)\1(?!\1)/g;

    interface Match { start: number; end: number; token: Token }
    const matches: Match[] = [];

    function scanAll(re: RegExp, build: (m: RegExpExecArray) => Token): void {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        // eslint-disable-next-line no-cond-assign
        while ((m = re.exec(input)) !== null) {
            matches.push({ start: m.index, end: m.index + m[0].length, token: build(m) });
        }
    }

    scanAll(FENCE_RE, (m) => ({ type: "pre", lang: m[1] ?? "", body: m[2] ?? "" }));
    scanAll(INLINE_CODE_RE, (m) => ({ type: "code", body: m[1] ?? "" }));
    scanAll(LINK_RE, (m) => ({ type: "link", body: m[1] ?? "", url: m[2] ?? "" }));
    scanAll(BOLD_RE, (m) => ({ type: "bold", body: m[2] ?? "" }));
    scanAll(STRIKE_RE, (m) => ({ type: "strike", body: m[1] ?? "" }));
    // Italic: the "(?:^|[^*_])" prefix may consume one char before the delim.
    // Adjust start index accordingly so the leading char remains plain text.
    ITALIC_RE.lastIndex = 0;
    {
        let m: RegExpExecArray | null;
        // eslint-disable-next-line no-cond-assign
        while ((m = ITALIC_RE.exec(input)) !== null) {
            const lead = m[0].startsWith(m[1]!) ? 0 : 1;
            matches.push({
                start: m.index + lead,
                end: m.index + m[0].length,
                token: { type: "italic", body: m[2] ?? "" },
            });
            ITALIC_RE.lastIndex = m.index + m[0].length;
        }
    }

    // Resolve overlaps: higher-priority patterns (inserted earlier) win.
    // Sort by start, skip any match whose range overlaps a previously-claimed one.
    matches.sort((a, b) => a.start - b.start || a.end - b.end);
    const claimed: Match[] = [];
    let cursor = 0;
    for (const mt of matches) {
        if (mt.start < cursor) continue;
        claimed.push(mt);
        cursor = mt.end;
    }

    // Emit: plain for gaps, formatted for claimed.
    const tokens: Token[] = [];
    cursor = 0;
    for (const mt of claimed) {
        if (mt.start > cursor) tokens.push({ type: "plain", body: input.slice(cursor, mt.start) });
        tokens.push(mt.token);
        cursor = mt.end;
    }
    if (cursor < input.length) tokens.push({ type: "plain", body: input.slice(cursor) });

    const out: string[] = [];
    for (const t of tokens) {
        switch (t.type) {
            case "plain":  out.push(escapePlain(t.body)); break;
            case "code":   out.push("`" + escapeCode(t.body) + "`"); break;
            case "pre":    out.push("```" + (t.lang ?? "") + "\n" + escapeCode(t.body) + "```"); break;
            case "link":   out.push("[" + escapePlain(t.body) + "](" + escapeUrl(t.url ?? "") + ")"); break;
            case "bold":   out.push("*" + escapePlain(t.body) + "*"); break;
            case "italic": out.push("_" + escapePlain(t.body) + "_"); break;
            case "strike": out.push("~" + escapePlain(t.body) + "~"); break;
        }
    }
    return out.join("");
}
