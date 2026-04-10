/**
 * Planda Assistant — In-memory Session Store
 *
 * Stateless-friendly conversation history yönetimi.
 * Her session, basit role/content çiftleri olarak saklanır.
 * TTL süresi dolan sessionlar otomatik temizlenir.
 */
// ─── Config ──────────────────────────────────────────────────────────────────
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 dakika hareketsizlik → sil
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 dakikada bir temizle
const MAX_HISTORY_TURNS = 40; // max 40 tur (= 80 mesaj) koru
// ─── Store ───────────────────────────────────────────────────────────────────
const store = new Map();
// Periyodik cleanup — Railway restart olursa zaten temizlenir
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, session] of store) {
        if (now - session.lastAccessed > SESSION_TTL_MS) {
            store.delete(id);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`[sessionStore] Cleaned ${cleaned} expired session(s). Active: ${store.size}`);
    }
}, CLEANUP_INTERVAL_MS);
// ─── Public API ───────────────────────────────────────────────────────────────
export function getHistory(sessionId) {
    const session = store.get(sessionId);
    if (!session)
        return [];
    session.lastAccessed = Date.now();
    return session.history;
}
export function saveHistory(sessionId, history) {
    // Sliding window — en eski mesajları at, son N turu koru
    const trimmed = history.length > MAX_HISTORY_TURNS * 2
        ? history.slice(-(MAX_HISTORY_TURNS * 2))
        : history;
    store.set(sessionId, {
        history: trimmed,
        lastAccessed: Date.now(),
    });
}
export function deleteSession(sessionId) {
    store.delete(sessionId);
}
export function sessionCount() {
    return store.size;
}
//# sourceMappingURL=sessionStore.js.map