/**
 * Planda Assistant — In-memory Session Store
 *
 * Stateless-friendly conversation history yönetimi.
 * Her session, basit role/content çiftleri olarak saklanır.
 * TTL süresi dolan sessionlar otomatik temizlenir.
 */
export interface ChatMessage {
    role: "user" | "assistant";
    content: string;
}
export declare function getHistory(sessionId: string): ChatMessage[];
export declare function saveHistory(sessionId: string, history: ChatMessage[]): void;
export declare function deleteSession(sessionId: string): void;
export declare function sessionCount(): number;
//# sourceMappingURL=sessionStore.d.ts.map