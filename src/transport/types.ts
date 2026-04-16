// =============================================================================
// Transport types — the cross-platform contract every adapter conforms to.
//
// One adapter per platform (CLI, Telegram, Slack, Synapse-A2A, ...). The
// dispatcher routes inbound `Message` objects from any adapter through the
// SAME pipeline (guardrails, whitelist, channel logging, session routing) and
// fans outbound `AgentResponse` objects back to the right adapter.
//
// User identity:
//   `senderId` is REQUIRED on every Message. It's the stable per-platform
//   user identifier (Telegram chat user_id, Slack member id, CLI process
//   user, Synapse agent name). The Sprint 5 whitelist + admin gate is keyed
//   on (platform, senderId). For richer identity (full name, role, avatar),
//   adapters expose the platform-original payload via `Message.raw`.
//
// File handling (BIDIRECTIONAL):
//   Adapters do platform-specific download/upload. They MUST extract text
//   from PDFs/CSVs/etc. AT THE BOUNDARY — never pass binary payloads
//   through to the agent's context. The agent receives `MediaPayload`s
//   that are model-ingestible: images as base64, text-extracted documents
//   as plain text, everything else as a path reference + metadata that
//   the agent can decide how to process via tools.
// =============================================================================

/** Standardized inbound message from any adapter. */
export interface Message {
    /** Platform identifier — must match the adapter's `platform` getter. */
    platform: string;

    /**
     * Stable per-platform identifier for the chat / channel / DM thread this
     * message arrived in. Used to route subsequent agent responses back to
     * the right place AND to scope per-chat Pi sessions in Sprint 4.
     *
     * Examples:
     *   - Telegram: chat_id (string of the int64)
     *   - Slack: channel_id (e.g. "C0123456")
     *   - CLI: a constant like "cli:default"
     *   - Synapse: peer agent name
     */
    channelId: string;

    /** Optional thread/sub-conversation id within a channel (Slack threads, etc.). */
    threadId?: string;

    /**
     * Stable per-platform user id of the sender. REQUIRED for all messages —
     * the whitelist (Sprint 5) gates on (platform, senderId).
     */
    senderId: string;

    /** Human-readable display name for logs and metadata-header injection. */
    senderDisplayName: string;

    /** Unix ms timestamp from the platform if available, else Date.now() at receipt. */
    timestamp: number;

    /** Plain text content of the message. May be empty if message was attachments-only. */
    text: string;

    /** Pre-processed attachments. Adapter has already done extraction/decoding. */
    attachments?: MediaPayload[];

    /**
     * Platform-original payload (Telegram Update, Slack Event, etc.). Adapters
     * SHOULD populate this so feature code can access richer metadata (full
     * user object, raw markdown formatting, etc.) without re-fetching.
     * Type is `unknown` — adapter-specific consumers must narrow.
     */
    raw?: unknown;
}

/**
 * Discriminated union covering everything an LLM might receive or produce.
 *
 *   - `image`: model-ready (base64 + mimeType). PNG/JPEG/WebP. The adapter
 *     downloaded the file and inlined it.
 *   - `text`: text already extracted from a document by the adapter
 *     (PDF→text via pdf-parse, CSV→text, JSON pretty-print, plain
 *     text/markdown). Goes into the agent's context as text.
 *   - `binary`: file the model can't ingest natively. Adapter saved it to
 *     disk and gives the agent a path + size. The agent decides whether
 *     to invoke a tool to process it (e.g. an Excel parser).
 */
export type MediaPayload =
    | {
          kind: "image";
          mimeType: string;     // e.g. "image/png"
          data: string;          // base64-encoded
          filename?: string;
      }
    | {
          kind: "text";
          mimeType: string;     // e.g. "application/pdf", "text/csv", "text/plain"
          text: string;          // already-extracted text content
          filename?: string;
          sourceBytes?: number;  // size of original file (for context)
      }
    | {
          kind: "binary";
          mimeType: string;
          localPath: string;     // path on bot's filesystem (under data/<bot>/incoming/ usually)
          sizeBytes: number;
          filename?: string;
      };

/** Standardized outbound response — what the agent sends back via the adapter. */
export interface AgentResponse {
    /** Plain text body of the response. */
    text: string;

    /** Optional attachments to send back. Adapter handles platform-specific upload. */
    attachments?: MediaPayload[];

    /**
     * Optional reference to the inbound message being replied to. Used by
     * threaded platforms (Slack threads, Telegram reply-to, etc.) to keep
     * conversation structure. Adapters that don't support threading ignore.
     */
    replyToMessageId?: string;

    /**
     * Optional explicit @-mention of the original sender. Useful in group
     * chats where the bot's reply might otherwise be ambiguous.
     */
    mentionsUser?: boolean;
}

/** Handler the dispatcher sets on each adapter — adapters call it on inbound. */
export type MessageHandler = (msg: Message) => Promise<void>;

/**
 * Status of an adapter — used by the /transports admin command to surface
 * per-adapter health without leaking platform-specific internals.
 */
export interface AdapterStatus {
    platform: string;
    state: "stopped" | "starting" | "running" | "error";
    lastError?: string;
    connectedAt?: number;
    /** Free-form details adapter wants to surface (e.g. bot username, channel count). */
    details?: Record<string, string | number | boolean>;
}

/**
 * Contract every transport adapter implements.
 *
 * SECURITY MODEL — read this before writing a new adapter:
 *
 *   - `platform` MUST be a hardcoded class constant (or constructor-set
 *     constant). It MUST NOT be derived from any user-controlled input.
 *     The dispatcher verifies on every dispatch that `msg.platform`
 *     matches `adapter.platform` and refuses mismatches.
 *
 *   - `platform === "cli"` is RESERVED for the bundled CliAdapter. The
 *     dispatcher rejects registrations with that platform name from any
 *     other adapter. (CLI is implicit-admin; no network adapter should
 *     inherit that status.)
 *
 *   - ALL inbound traffic MUST flow through `dispatcher.dispatch()` (which
 *     adapters trigger via the handler installed by `setHandler`). Pushing
 *     directly into the Pi session via `pi.sendUserMessage(...)` from an
 *     extension BYPASSES the entire whitelist + ACL gate AND falls back to
 *     the CLI implicit-admin identity. Never do this for traffic that
 *     originated externally.
 *
 *   - Adapters MUST NOT honor `Message.platform` from inbound payloads —
 *     they construct it themselves from the hardcoded constant.
 */
export interface TransportAdapter {
    /** Stable platform identifier — must match `Message.platform` of inbound. */
    readonly platform: string;

    /** Begin listening for inbound. May download model files / open sockets. */
    start(): Promise<void>;

    /** Cleanly stop. Must be idempotent. */
    stop(): Promise<void>;

    /** Send an outbound response to the given channel. */
    send(channelId: string, response: AgentResponse): Promise<void>;

    /** Dispatcher calls this once at registration to install the inbound handler. */
    setHandler(handler: MessageHandler): void;

    /** Current status — surfaced via /transports. */
    status(): AdapterStatus;
}
