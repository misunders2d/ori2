import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as cheerio from "cheerio";

const MAX_TEXT_BYTES = 25_000;

// Pull readable text out of HTML; strips boilerplate.
function extractHtmlText(html: string): string {
    const $ = cheerio.load(html);
    $("script, style, nav, footer, iframe, noscript").remove();
    return $("body").text().replace(/\s+/g, " ").trim();
}

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "web_fetch",
        label: "Fetch Webpage Content",
        description:
            "Fetch and read the text content of a URL. Branches on content-type: HTML→text-extracted, plain text/markdown/JSON→inline, other (PDF/images/binaries)→reports the type and size, suggests dedicated parsing.",
        parameters: Type.Object({
            url: Type.String({ description: "The full URL to fetch" }),
        }),
        async execute(_id, params, signal, onUpdate) {
            onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.url}...` }], details: {} });
            const response = await fetch(params.url, signal ? { signal } : {});
            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

            const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
            const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");
            const isText = contentType.startsWith("text/") || contentType.includes("application/json") || contentType.includes("application/xml");

            if (isHtml) {
                const html = await response.text();
                const text = extractHtmlText(html);
                const truncated = text.length > MAX_TEXT_BYTES;
                const out = text.slice(0, MAX_TEXT_BYTES) + (truncated ? "\n...(truncated)" : "");
                return {
                    content: [{ type: "text", text: out }],
                    details: { content_type: contentType, full_length: text.length, truncated },
                };
            }

            if (isText) {
                const text = await response.text();
                const truncated = text.length > MAX_TEXT_BYTES;
                const out = text.slice(0, MAX_TEXT_BYTES) + (truncated ? "\n...(truncated)" : "");
                return {
                    content: [{ type: "text", text: out }],
                    details: { content_type: contentType, full_length: text.length, truncated },
                };
            }

            // Binary / unsupported — report type without dumping bytes into context.
            const len = response.headers.get("content-length") ?? "unknown";
            return {
                content: [{
                    type: "text",
                    text: `Non-text content. Content-Type: ${contentType || "unknown"}, Content-Length: ${len}. Use a dedicated parser (PDF: read with the appropriate tool, images: pass through media handler).`,
                }],
                details: { content_type: contentType, content_length: len, parsed: false },
            };
        },
    });

    pi.registerTool({
        name: "web_search",
        label: "Search the Web",
        description: "Perform a web search to find documentation, news, or answers (DuckDuckGo HTML, no API key required).",
        parameters: Type.Object({
            query: Type.String({ description: "The search query" }),
        }),
        async execute(_id, params, signal, onUpdate) {
            onUpdate?.({ content: [{ type: "text", text: `Searching for '${params.query}'...` }], details: {} });
            const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(params.query)}`;
            const response = await fetch(searchUrl, signal ? { signal } : {});
            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
            const html = await response.text();

            const $ = cheerio.load(html);
            const results: { title: string; url: string; snippet: string }[] = [];
            $(".result").each((i, el) => {
                if (i >= 5) return;
                const title = $(el).find(".result__title").text().trim();
                const snippet = $(el).find(".result__snippet").text().trim();
                const link = $(el).find(".result__url").text().trim();
                if (title && link) results.push({ title, url: `https://${link}`, snippet });
            });

            if (results.length === 0) {
                return {
                    content: [{ type: "text", text: "No results found. DuckDuckGo may be rate-limiting; try a different query or wait a moment." }],
                    details: { query: params.query, results: [] },
                };
            }

            const formatted = results
                .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`)
                .join("\n\n");
            return {
                content: [{ type: "text", text: formatted }],
                details: { query: params.query, results },
            };
        },
    });
}
