/**
 * Planda Assistant — Session Store
 *
 * Redis varsa Redis kullanır (REDIS_URL env var).
 * Redis yoksa in-memory store'a düşer (local dev / fallback).
 *
 * Redis: Railway private networking → redis.railway.internal:6379
 * TTL: 30 dakika hareketsizlik → oturum silinir
 */
export interface ChatMessage {
    role: "user" | "assistant";
    content: string;
}
export declare function getHistory(sessionId: string): Promise<ChatMessage[]>;
export declare function saveHistory(sessionId: string, history: ChatMessage[]): Promise<void>;
export declare function deleteSession(sessionId: string): Promise<void>;
export declare function sessionCount(): number;
//# sourceMappingURL=sessionStore.d.ts.map