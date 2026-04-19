import fs from "node:fs";
import path from "node:path";
import { botSubdir, ensureDir } from "../core/paths.js";
import { getVault } from "../core/vault.js";
import { writeHeartbeat } from "../core/heartbeat.js";
import { logError, logWarning } from "../core/errorLog.js";
import { fileToPayload, type MediaSaveContext } from "./media.js";
import { chunkParagraphs, toMarkdownV2, TELEGRAM_MAX_TEXT } from "./telegramFormatting.js";
import type {
    AdapterStatus,
    AgentResponse,
    MediaPayload,
    Message,
    MessageHandler,
    TransportAdapter,
} from "./types.js";

// =============================================================================
// TelegramAdapter — long-poll Bot API via raw fetch (no node-telegram-bot-api dep).
//
// Setup:
//   1. Create a bot with @BotFather → get token.
//   2. Either:
//        (a) `/connect-telegram <token>` from any active session (validates +
//            stores in vault + restarts adapter), OR
//        (b) Direct vault edit: set TELEGRAM_BOT_TOKEN and restart bot.
//   3. The admin_gate extension's pre-dispatch hook enforces the whitelist
//      on every inbound message (Sprint 5). This adapter no longer does
//      its own allowlist — rejection happens uniformly for all adapters.
//
// Inbound:
//   getUpdates long-poll loop (timeout=30s). offset persisted to
//   data/<bot>/telegram_state.json so restart doesn't replay.
//
// Multi-user / multi-chat scope (SCOPED FOR SPRINT 4):
//   ALL Telegram chats funnel into the SINGLE Pi session, with strong
//   sender-metadata headers attached by transport_bridge.ts. This is
//   functional for "1 bot, 1-2 chats" deployments. Per-chat session
//   isolation (the original ori `tg_<chat_id>` model — one Pi session
//   per Telegram chat) is a real refactor of bootstrap and the bridge,
//   tracked as follow-up work after Sprint 5.
//
// Files:
//   - Photos: smallest acceptable variant downloaded → MediaPayload.image
//   - Documents: download → fileToPayload() (text-extracted for PDF/CSV/
//     etc., binary fallback for the rest, saved under
//     data/<bot>/incoming/telegram/)
//   - Audio/voice/video: saved as binary; transcription is a future tool
//
// Outbound:
//   - text → sendMessage
//   - image attachment → sendPhoto (one per call, multi attachment = multi call)
//   - text attachment / binary → sendDocument
//   - replyToMessageId → reply_to_message_id
// =============================================================================

const TELEGRAM_API_BASE = "https://api.telegram.org";
const POLL_TIMEOUT_SECS = 30;
// Telegram's hard per-message text cap. Exposed via telegramFormatting.TELEGRAM_MAX_TEXT
// for any module that wants to compose without the adapter.
const MAX_TELEGRAM_TEXT = TELEGRAM_MAX_TEXT;

export interface TelegramUser {
    id: number;
    is_bot: boolean;
    first_name: string;
    last_name?: string;
    username?: string;
}

interface TelegramChat {
    id: number;
    type: "private" | "group" | "supergroup" | "channel";
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
}

interface TelegramPhotoSize {
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
}

interface TelegramDocument {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
}

/** Subset of Telegram MessageEntity we use for mention detection. */
interface TelegramEntity {
    /** "mention" = @username; "text_mention" = link to a user (includes private users with no @username). */
    type: "mention" | "text_mention" | string;
    offset: number;
    length: number;
    /** Only present for "text_mention". */
    user?: TelegramUser;
}

export interface TelegramMessage {
    message_id: number;
    from?: TelegramUser;
    chat: TelegramChat;
    date: number;
    text?: string;
    caption?: string;
    /** Set by Telegram on every message in a multi-photo/multi-video upload
     *  ("album"). Messages with the same ID arrive as separate updates and
     *  must be merged into one logical inbound so the agent sees all media
     *  at once. */
    media_group_id?: string;
    entities?: TelegramEntity[];
    caption_entities?: TelegramEntity[];
    photo?: TelegramPhotoSize[];
    document?: TelegramDocument;
    audio?: TelegramDocument & { duration: number };
    voice?: TelegramDocument & { duration: number };
    video?: TelegramDocument & { duration: number; width: number; height: number };
    reply_to_message?: TelegramMessage;
}

/** Module-level debounce for albums. Source: pi-telegram (Pi SDK's own
 *  Telegram extension) uses 1200ms; we match for consistency. */
const MEDIA_GROUP_DEBOUNCE_MS = 1200;

interface MediaGroupState {
    messages: TelegramMessage[];
    flushTimer: ReturnType<typeof setTimeout>;
}

interface TelegramUpdate {
    update_id: number;
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
    ok: boolean;
    result?: T;
    description?: string;
    error_code?: number;
}

export class TelegramAdapter implements TransportAdapter {
    readonly platform = "telegram";

    private state: AdapterStatus["state"] = "stopped";
    private lastError: string | undefined;
    private connectedAt: number | undefined;
    private botInfo: TelegramUser | undefined;

    private handler: MessageHandler | null = null;
    private pollAbort: AbortController | null = null;
    private pollPromise: Promise<void> | null = null;
    private offset = 0;
    private offsetFile: string;
    private incomingDir: string;

    /** Active media-group buffers keyed by `${chat.id}:${media_group_id}`.
     *  Each entry accumulates messages until the debounce timer fires, then
     *  flushes them as ONE logical inbound with merged attachments[]. */
    private mediaGroups = new Map<string, MediaGroupState>();

    constructor() {
        const dir = botSubdir("");
        this.offsetFile = path.join(dir, "telegram_state.json");
        this.incomingDir = path.join(dir, "incoming", "telegram");
        ensureDir(this.incomingDir);
        this.loadOffset();
    }

    setHandler(handler: MessageHandler): void {
        this.handler = handler;
    }

    async start(): Promise<void> {
        const token = getVault().get("TELEGRAM_BOT_TOKEN");
        if (!token) {
            this.state = "stopped";
            this.lastError = "TELEGRAM_BOT_TOKEN not set in vault — use /connect-telegram <token> to enable";
            return;
        }
        this.state = "starting";
        this.lastError = undefined;

        try {
            const me = await this.callApi<TelegramUser>(token, "getMe", {});
            this.botInfo = me;
        } catch (e) {
            this.state = "error";
            this.lastError = `getMe failed: ${e instanceof Error ? e.message : String(e)}`;
            return;
        }

        this.pollAbort = new AbortController();
        this.pollPromise = this.runPollLoop(token, this.pollAbort.signal).catch((e) => {
            this.state = "error";
            this.lastError = `poll loop crashed: ${e instanceof Error ? e.message : String(e)}`;
        });
        this.state = "running";
        this.connectedAt = Date.now();
    }

    async stop(): Promise<void> {
        this.state = "stopped";
        if (this.pollAbort) {
            this.pollAbort.abort();
            this.pollAbort = null;
        }
        if (this.pollPromise) {
            try { await this.pollPromise; } catch { /* abort throws — expected */ }
            this.pollPromise = null;
        }
        // Cancel any in-flight media-group debounce timers. Buffered messages
        // are dropped — acceptable on shutdown (sender will just re-send on
        // reconnect; the poll offset guarantees we don't replay).
        for (const state of this.mediaGroups.values()) {
            clearTimeout(state.flushTimer);
        }
        this.mediaGroups.clear();
    }

    async send(channelId: string, response: AgentResponse): Promise<void> {
        const token = getVault().get("TELEGRAM_BOT_TOKEN");
        if (!token) throw new Error("[telegram] cannot send — TELEGRAM_BOT_TOKEN not set");
        const chatId = Number(channelId);
        if (!Number.isFinite(chatId)) throw new Error(`[telegram] invalid channelId: ${channelId}`);

        // Text path: paragraph-aware chunk → try MarkdownV2 → fall back to
        // plain text on parse error. Converting + escaping happens PER CHUNK
        // (each chunk must be independently parseable by Telegram), then
        // send with parse_mode:"MarkdownV2". On 400 Bad Request from
        // MarkdownV2 parsing, retry the same chunk without parse_mode so
        // the user ALWAYS receives the content (worst case: raw markdown
        // tokens, still readable).
        const text = response.text || "";
        const chunks = chunkParagraphs(text, MAX_TELEGRAM_TEXT);
        const replyTo = response.replyToMessageId ? Number(response.replyToMessageId) : undefined;
        for (let i = 0; i < chunks.length; i++) {
            const baseParams: Record<string, unknown> = { chat_id: chatId };
            if (i === 0 && replyTo !== undefined && Number.isFinite(replyTo)) {
                baseParams["reply_to_message_id"] = replyTo;
            }
            await this.sendMessageWithMarkdownFallback(token, baseParams, chunks[i]!);
        }

        // Send any attachments AFTER the text so the user has context.
        if (response.attachments) {
            for (const att of response.attachments) {
                await this.sendAttachment(token, chatId, att);
            }
        }
    }

    /**
     * Send one chunk: first attempt as MarkdownV2, on parse-error retry as
     * plain. MarkdownV2's escaping rules are strict — even correct escaping
     * can miss an edge case (nested entities, obscure emoji sequences).
     * The retry guarantees delivery.
     */
    private async sendMessageWithMarkdownFallback(
        token: string,
        baseParams: Record<string, unknown>,
        rawChunk: string,
    ): Promise<void> {
        const v2 = toMarkdownV2(rawChunk);
        try {
            await this.callApi(token, "sendMessage", {
                ...baseParams,
                text: v2,
                parse_mode: "MarkdownV2",
            });
            return;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Telegram returns 400 Bad Request with a description like
            // "can't parse entities: ..." on V2 parse failure. Non-parse
            // errors (rate limit, network) should propagate; we only retry
            // on the specific parse-error signal.
            if (!/parse entities|can't parse|bad request/i.test(msg)) throw e;
            logWarning("telegram", "MarkdownV2 send failed — retrying as plain text", {
                err: msg.slice(0, 200),
                chunkChars: rawChunk.length,
            });
            await this.callApi(token, "sendMessage", {
                ...baseParams,
                text: rawChunk,
            });
        }
    }

    /**
     * Push a transient "typing…" indicator to the channel. Telegram clears it
     * automatically after ~5 seconds, so callers loop on a ~4-second cadence
     * to keep it visible while the agent is processing. Best-effort — never
     * throws; a failed indicator must not break message handling.
     */
    async sendTyping(channelId: string): Promise<void> {
        const token = getVault().get("TELEGRAM_BOT_TOKEN");
        if (!token) return;
        const chatId = Number(channelId);
        if (!Number.isFinite(chatId)) return;
        try {
            await this.callApi(token, "sendChatAction", { chat_id: chatId, action: "typing" });
        } catch {
            /* best-effort — no log spam if it fails */
        }
    }

    status(): AdapterStatus {
        const status: AdapterStatus = {
            platform: this.platform,
            state: this.state,
            details: {
                offset: this.offset,
                bot_username: this.botInfo?.username ?? "(unknown)",
                bot_id: this.botInfo?.id ?? 0,
            },
        };
        if (this.lastError !== undefined) status.lastError = this.lastError;
        if (this.connectedAt !== undefined) status.connectedAt = this.connectedAt;
        return status;
    }

    // ---------------- internal ----------------

    private async runPollLoop(token: string, signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            try {
                const updates = await this.callApi<TelegramUpdate[]>(token, "getUpdates", {
                    offset: this.offset,
                    timeout: POLL_TIMEOUT_SECS,
                    allowed_updates: ["message", "edited_message"],
                }, signal);
                // Successful long-poll cycle — heartbeat regardless of update
                // count, so an idle bot still proves liveness every ~30s.
                writeHeartbeat("telegram", `offset=${this.offset} updates=${updates.length}`);
                for (const update of updates) {
                    if (update.update_id >= this.offset) this.offset = update.update_id + 1;
                    const msg = update.message ?? update.edited_message;
                    if (!msg) continue;
                    try {
                        await this.handleIncoming(token, msg);
                    } catch (e) {
                        logError("telegram", "handleIncoming failed", { err: e instanceof Error ? e.message : String(e) });
                    }
                }
                this.saveOffset();
            } catch (e) {
                if (signal.aborted) return;
                logWarning("telegram", "poll error (will retry)", { err: e instanceof Error ? e.message : String(e) });
                // Short backoff before retry.
                await sleep(2000, signal);
            }
        }
    }

    private async handleIncoming(token: string, m: TelegramMessage): Promise<void> {
        const sender = m.from;
        if (!sender) return; // channel posts without a sender — ignore for now
        if (sender.is_bot) return; // ignore other bots

        // Album buffering: when the user sends N photos/videos at once,
        // Telegram delivers N separate updates all sharing a media_group_id.
        // Forwarding each one through the dispatcher individually would
        // kick off N separate agent turns and drown the bot (with the user
        // having intended ONE message). Buffer by media_group_id for
        // MEDIA_GROUP_DEBOUNCE_MS, then flush the batch as one logical
        // inbound with merged attachments[]. Matches pi-telegram's 1200ms
        // debounce (Pi SDK's own Telegram reference extension).
        if (m.media_group_id) {
            const key = `${m.chat.id}:${m.media_group_id}`;
            const existing = this.mediaGroups.get(key);
            if (existing) {
                clearTimeout(existing.flushTimer);
                existing.messages.push(m);
                existing.flushTimer = setTimeout(() => {
                    void this.flushMediaGroup(token, key);
                }, MEDIA_GROUP_DEBOUNCE_MS);
                existing.flushTimer.unref();
            } else {
                const state: MediaGroupState = {
                    messages: [m],
                    flushTimer: setTimeout(() => {
                        void this.flushMediaGroup(token, key);
                    }, MEDIA_GROUP_DEBOUNCE_MS),
                };
                state.flushTimer.unref();
                this.mediaGroups.set(key, state);
            }
            return;
        }

        await this.dispatchTelegramMessages(token, [m]);
    }

    /** Flush a media-group buffer — called when the debounce timer fires. */
    private async flushMediaGroup(token: string, key: string): Promise<void> {
        const state = this.mediaGroups.get(key);
        if (!state) return;
        this.mediaGroups.delete(key);
        try {
            await this.dispatchTelegramMessages(token, state.messages);
        } catch (e) {
            logError("telegram", "media-group flush failed", {
                key,
                count: state.messages.length,
                err: e instanceof Error ? e.message : String(e),
            });
        }
    }

    /**
     * Normalize a single message OR an album's worth of messages into one
     * cross-platform `Message`. The first message's chat/sender/date anchors
     * the logical inbound; captions and text are joined; attachments from
     * every message in the album merge into `attachments[]`.
     */
    private async dispatchTelegramMessages(token: string, msgs: TelegramMessage[]): Promise<void> {
        if (msgs.length === 0) return;
        const head = msgs[0]!;
        const sender = head.from;
        if (!sender) return;

        // Merge text: take the first non-empty text/caption across the group.
        // Albums typically carry a single caption on one of the items.
        const textParts: string[] = [];
        for (const m of msgs) {
            const t = (m.text ?? m.caption ?? "").trim();
            if (t.length > 0) textParts.push(t);
        }
        const text = textParts.join("\n\n");

        // Merge attachments: download each message's media in order.
        const attachments: MediaPayload[] = [];
        for (const m of msgs) {
            const part = await this.collectAttachments(token, m);
            attachments.push(...part);
        }

        if (!this.handler) {
            console.log("[telegram] message received but no handler installed yet — dropping");
            return;
        }

        const senderDisplayName =
            sender.username ? `@${sender.username}` :
            sender.last_name ? `${sender.first_name} ${sender.last_name}` :
            sender.first_name;

        const incoming: Message = {
            platform: this.platform,
            channelId: String(head.chat.id),
            senderId: String(sender.id),
            senderDisplayName,
            timestamp: head.date * 1000,
            text,
            addressedToBot: isAddressedToBot(head, text, this.botInfo),
            raw: msgs.length === 1 ? head : msgs,
        };
        if (attachments.length > 0) incoming.attachments = attachments;

        await this.handler(incoming);
    }

    private async collectAttachments(token: string, m: TelegramMessage): Promise<MediaPayload[]> {
        const out: MediaPayload[] = [];

        const ctx: MediaSaveContext = {
            incomingDir: this.incomingDir,
            saveBinary: async (filename, buf) => {
                const safeName = `${Date.now()}_${filename}`;
                const dest = path.join(this.incomingDir, safeName);
                await fs.promises.writeFile(dest, buf);
                return dest;
            },
        };

        if (m.photo && m.photo.length > 0) {
            // Pick the largest variant available — better for vision models.
            const largest = [...m.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0]!;
            const buf = await this.downloadFile(token, largest.file_id);
            out.push(...await fileToPayload(buf, "image/jpeg", undefined, ctx));
        }
        if (m.document) {
            const buf = await this.downloadFile(token, m.document.file_id);
            out.push(...await fileToPayload(buf, m.document.mime_type ?? "application/octet-stream", m.document.file_name, ctx));
        }
        if (m.audio) {
            const buf = await this.downloadFile(token, m.audio.file_id);
            out.push(...await fileToPayload(buf, m.audio.mime_type ?? "audio/mpeg", m.audio.file_name ?? "audio", ctx));
        }
        if (m.voice) {
            const buf = await this.downloadFile(token, m.voice.file_id);
            out.push(...await fileToPayload(buf, m.voice.mime_type ?? "audio/ogg", "voice.ogg", ctx));
        }
        if (m.video) {
            const buf = await this.downloadFile(token, m.video.file_id);
            out.push(...await fileToPayload(buf, m.video.mime_type ?? "video/mp4", m.video.file_name ?? "video.mp4", ctx));
        }
        return out;
    }

    private async downloadFile(token: string, fileId: string): Promise<Buffer> {
        const fileInfo = await this.callApi<{ file_path: string }>(token, "getFile", { file_id: fileId });
        if (!fileInfo.file_path) throw new Error(`getFile returned no file_path for ${fileId}`);
        const url = `${TELEGRAM_API_BASE}/file/bot${token}/${fileInfo.file_path}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        return Buffer.from(buf);
    }

    private async sendAttachment(token: string, chatId: number, att: MediaPayload): Promise<void> {
        if (att.kind === "image") {
            const form = new FormData();
            form.append("chat_id", String(chatId));
            form.append("photo", new Blob([Buffer.from(att.data, "base64")], { type: att.mimeType }), att.filename ?? "image.png");
            await this.callApiForm(token, "sendPhoto", form);
        } else if (att.kind === "text") {
            const form = new FormData();
            form.append("chat_id", String(chatId));
            form.append("document", new Blob([Buffer.from(att.text, "utf-8")], { type: att.mimeType }), att.filename ?? "attachment.txt");
            await this.callApiForm(token, "sendDocument", form);
        } else {
            const form = new FormData();
            form.append("chat_id", String(chatId));
            const buf = await fs.promises.readFile(att.localPath);
            form.append("document", new Blob([buf], { type: att.mimeType }), att.filename ?? path.basename(att.localPath));
            await this.callApiForm(token, "sendDocument", form);
        }
    }

    private async callApi<T>(
        token: string,
        method: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<T> {
        const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
        const init: RequestInit = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
        };
        if (signal) init.signal = signal;
        const res = await fetch(url, init);
        const json = (await res.json()) as TelegramApiResponse<T>;
        if (!json.ok) {
            throw new Error(`Telegram API ${method}: ${json.description ?? `HTTP ${res.status}`}`);
        }
        return json.result as T;
    }

    private async callApiForm<T>(token: string, method: string, form: FormData): Promise<T> {
        const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
        const res = await fetch(url, { method: "POST", body: form });
        const json = (await res.json()) as TelegramApiResponse<T>;
        if (!json.ok) {
            throw new Error(`Telegram API ${method}: ${json.description ?? `HTTP ${res.status}`}`);
        }
        return json.result as T;
    }

    private loadOffset(): void {
        try {
            if (!fs.existsSync(this.offsetFile)) return;
            const data = JSON.parse(fs.readFileSync(this.offsetFile, "utf-8")) as { offset?: number };
            if (typeof data.offset === "number") this.offset = data.offset;
        } catch {
            // Corrupt state file — start fresh.
        }
    }

    private saveOffset(): void {
        try {
            fs.writeFileSync(this.offsetFile, JSON.stringify({ offset: this.offset }, null, 2));
        } catch (e) {
            console.error("[telegram] failed to persist offset:", e);
        }
    }
}

/**
 * Decide if a Telegram message is directly addressed to our bot.
 *
 * DM (chat.type === "private"): always true — every DM is for the bot.
 *
 * Group / supergroup / channel:
 *   - `reply_to_message.from.id === bot.id` — replying to a bot message.
 *   - `entities` contains a `mention` whose span equals `@<bot.username>`.
 *   - `entities` contains a `text_mention` whose `user.id === bot.id`
 *     (covers users without a public @username).
 *   - Same checks on `caption_entities` for media with caption.
 *
 * Exported for unit testing; intentionally pure.
 */
export function isAddressedToBot(
    m: TelegramMessage,
    text: string,
    botInfo: TelegramUser | undefined,
): boolean {
    if (m.chat.type === "private") return true;
    if (!botInfo) return false; // can't decide without our own id/username

    if (m.reply_to_message?.from?.id === botInfo.id) return true;

    const botUsernameLc = botInfo.username?.toLowerCase();
    const entities = [...(m.entities ?? []), ...(m.caption_entities ?? [])];
    for (const e of entities) {
        if (e.type === "text_mention" && e.user?.id === botInfo.id) return true;
        if (e.type === "mention" && botUsernameLc) {
            const span = text.slice(e.offset, e.offset + e.length).toLowerCase();
            if (span === `@${botUsernameLc}`) return true;
        }
    }
    return false;
}

// chunkText removed — superseded by chunkParagraphs in telegramFormatting.ts
// (paragraph/line-boundary-aware split; the old brute-force char slice
// broke mid-word and — post-MarkdownV2 — mid-entity).

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
        }, { once: true });
    });
}
