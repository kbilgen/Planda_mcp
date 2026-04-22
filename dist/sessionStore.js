/**
 * Planda Assistant — Session Store
 *
 * Redis varsa Redis kullanır (REDIS_URL env var).
 * Redis yoksa in-memory store'a düşer (local dev / fallback).
 *
 * Redis: Railway private networking → redis.railway.internal:6379
 * TTL: 30 dakika hareketsizlik → oturum silinir
 */
import { Redis } from "ioredis";
// ─── Config ──────────────────────────────────────────────────────────────────
const SESSION_TTL_SEC = 30 * 60; // 30 dakika (Redis TTL saniye cinsinden)
const SESSION_TTL_MS = SESSION_TTL_SEC * 1000; // in-memory için ms
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_HISTORY_TURNS = 40;
const KEY_PREFIX = "planda:session:";
// ─── Redis client (export — auth.ts de kullanır) ─────────────────────────────
let redis = null;
if (process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false,
    });
    redis.on("connect", () => console.log("[sessionStore] Redis connected"));
    redis.on("error", (err) => console.error("[sessionStore] Redis error:", err.message));
    redis.on("close", () => console.log("[sessionStore] Redis connection closed"));
    console.log("[sessionStore] Mode: Redis (persistent)");
}
else {
    console.log("[sessionStore] Mode: in-memory (set REDIS_URL for persistence)");
}
const memStore = new Map();
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, s] of memStore) {
        if (now - s.lastAccessed > SESSION_TTL_MS) {
            memStore.delete(id);
            cleaned++;
        }
    }
    if (cleaned > 0)
        console.log(`[sessionStore] Cleaned ${cleaned} expired in-memory session(s)`);
}, CLEANUP_INTERVAL_MS);
// ─── Helpers ──────────────────────────────────────────────────────────────────
function trim(history) {
    const max = MAX_HISTORY_TURNS * 2; // her tur = user + assistant
    return history.length > max ? history.slice(-max) : history;
}
// ─── Public API ───────────────────────────────────────────────────────────────
export async function getHistory(sessionId) {
    if (redis) {
        try {
            // GETEX: atomically read + reset TTL in one round-trip (sliding window)
            const raw = await redis.getex(KEY_PREFIX + sessionId, "EX", SESSION_TTL_SEC);
            if (!raw)
                return [];
            return JSON.parse(raw);
        }
        catch (err) {
            console.error("[sessionStore] Redis get error:", err);
            // Redis hatası → in-memory'e düş
        }
    }
    const s = memStore.get(sessionId);
    if (!s)
        return [];
    s.lastAccessed = Date.now();
    return s.history;
}
export async function saveHistory(sessionId, history) {
    const trimmed = trim(history);
    if (redis) {
        try {
            await redis.set(KEY_PREFIX + sessionId, JSON.stringify(trimmed), "EX", SESSION_TTL_SEC);
            return;
        }
        catch (err) {
            console.error("[sessionStore] Redis set error:", err);
        }
    }
    memStore.set(sessionId, { history: trimmed, lastAccessed: Date.now() });
}
export async function deleteSession(sessionId) {
    if (redis) {
        try {
            await redis.del(KEY_PREFIX + sessionId);
            return;
        }
        catch (err) {
            console.error("[sessionStore] Redis del error:", err);
        }
    }
    memStore.delete(sessionId);
}
/** Shared Redis client — auth.ts tarafından import edilir */
export function getRedis() {
    return redis;
}
export function sessionCount() {
    // Redis modunda anlık sayı zaten Redis tarafında; in-memory için local map
    return memStore.size;
}
//# sourceMappingURL=sessionStore.js.map