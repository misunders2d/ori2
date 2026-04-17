import { getVault } from "./vault.js";
import { getWhitelist } from "./whitelist.js";

// =============================================================================
// Per-user token-bucket rate limiter.
//
// Goal: prevent a single user from burning through API budget (the bot's
// model API costs are per-token, attacker spam = real money). Per-(platform,
// senderId) buckets, in-memory (lost on restart — that's fine for rate
// limiting; long restarts already serve as cooldown).
//
// Configuration: vault entry AGENT_RPM (requests-per-minute). Default 30.
// At 30 RPM = 1 request every 2s sustained, with burst capacity equal to
// the full bucket (= AGENT_RPM tokens). Reasonable for chat where bursts
// of 2-3 messages are normal but 100 in a minute is abuse.
//
// Exemptions:
//   - CLI: operator owns the process.
//   - Admins: an admin in the middle of an incident shouldn't be told
//     "you're rate-limited, please wait" — they need full access.
//
// API:
//   tryConsume(platform, senderId): { allowed, remaining, retryAfterMs }
//     Returns whether the call is allowed; if not, when to retry.
//   reset(platform, senderId): clears one bucket (for /limits reset).
//   resetAll(): clears every bucket (admin recovery).
//   status(platform, senderId): peek without consuming.
//   stats(): per-bucket snapshot for /limits status.
// =============================================================================

const DEFAULT_RPM = 30;

interface Bucket {
    tokens: number;
    capacity: number;       // RPM at the time the bucket was created
    refillPerMs: number;
    lastRefillAt: number;
    consumed: number;       // total tokens ever consumed (lifetime stat)
    blocked: number;        // total times we said "no" to this bucket
    firstSeenAt: number;
}

export interface ConsumeResult {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;   // 0 if allowed, else ms until next token
}

export interface BucketStats {
    platform: string;
    senderId: string;
    capacity: number;
    tokens: number;
    consumed: number;
    blocked: number;
    age_ms: number;
}

function rpmFromVault(): number {
    const raw = getVault().get("AGENT_RPM");
    if (!raw) return DEFAULT_RPM;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_RPM;
    return Math.floor(n);
}

function keyOf(platform: string, senderId: string): string {
    return `${platform}:${senderId}`;
}

export class RateLimiter {
    private buckets = new Map<string, Bucket>();
    private cachedRpm: number | null = null;

    /** Force a re-read of AGENT_RPM from the vault. Call after an admin sets it. */
    reloadConfig(): void {
        this.cachedRpm = null;
    }

    private rpm(): number {
        if (this.cachedRpm == null) this.cachedRpm = rpmFromVault();
        return this.cachedRpm;
    }

    private getBucket(platform: string, senderId: string): Bucket {
        const k = keyOf(platform, senderId);
        let b = this.buckets.get(k);
        const rpm = this.rpm();
        if (!b) {
            b = {
                tokens: rpm,
                capacity: rpm,
                refillPerMs: rpm / 60_000,
                lastRefillAt: Date.now(),
                consumed: 0,
                blocked: 0,
                firstSeenAt: Date.now(),
            };
            this.buckets.set(k, b);
        }
        return b;
    }

    private refill(b: Bucket): void {
        const now = Date.now();
        const elapsed = now - b.lastRefillAt;
        if (elapsed <= 0) return;
        const newTokens = b.tokens + elapsed * b.refillPerMs;
        b.tokens = Math.min(b.capacity, newTokens);
        b.lastRefillAt = now;
    }

    /**
     * Try to consume one token for this user. Exempts CLI and admins.
     * Returns whether the call may proceed and how long to wait if not.
     */
    tryConsume(platform: string, senderId: string): ConsumeResult {
        // Exemptions.
        if (platform === "cli") return { allowed: true, remaining: Infinity, retryAfterMs: 0 };
        if (getWhitelist().isAdmin(platform, senderId)) return { allowed: true, remaining: Infinity, retryAfterMs: 0 };

        const b = this.getBucket(platform, senderId);
        this.refill(b);

        if (b.tokens >= 1) {
            b.tokens -= 1;
            b.consumed += 1;
            return { allowed: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
        }
        b.blocked += 1;
        const deficit = 1 - b.tokens;
        const retryAfterMs = Math.ceil(deficit / b.refillPerMs);
        return { allowed: false, remaining: 0, retryAfterMs };
    }

    /** Peek without consuming. */
    status(platform: string, senderId: string): { tokens: number; capacity: number; retryAfterMs: number } {
        const b = this.getBucket(platform, senderId);
        this.refill(b);
        const retryAfterMs = b.tokens >= 1 ? 0 : Math.ceil((1 - b.tokens) / b.refillPerMs);
        return { tokens: Math.floor(b.tokens), capacity: b.capacity, retryAfterMs };
    }

    reset(platform: string, senderId: string): boolean {
        const k = keyOf(platform, senderId);
        return this.buckets.delete(k);
    }

    resetAll(): number {
        const n = this.buckets.size;
        this.buckets.clear();
        return n;
    }

    stats(): BucketStats[] {
        const now = Date.now();
        const out: BucketStats[] = [];
        for (const [k, b] of this.buckets.entries()) {
            this.refill(b);
            const [platform, ...rest] = k.split(":");
            out.push({
                platform: platform!,
                senderId: rest.join(":"),
                capacity: b.capacity,
                tokens: Math.floor(b.tokens),
                consumed: b.consumed,
                blocked: b.blocked,
                age_ms: now - b.firstSeenAt,
            });
        }
        return out.sort((a, b) => b.consumed - a.consumed);
    }
}

import { getOrCreate } from "./singletons.js";
export function getRateLimiter(): RateLimiter {
    return getOrCreate("rateLimiter", () => new RateLimiter());
}
