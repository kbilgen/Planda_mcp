/**
 * Planda Auth — Token Validation
 *
 * Laravel Sanctum format: "{id}|{token}" — local validation impossible.
 * Validates by calling Planda /marketplace/clients/{userId} with the
 * bearer; cached in Redis for 5 minutes.
 *
 * Akış:
 *   1. Redis cache → hit ise anında dön (~1ms)
 *   2. Miss ise Planda /marketplace/clients/{userId} çağrı (~200ms)
 *      - 200 → token geçerli ve userId ile eşleşiyor
 *      - 401 → token geçersiz
 *      - 403 → token başka bir user'ın (impersonation) → reject
 *      - 404 → user bulunamadı → reject
 *   3. Başarılıysa sonucu cache'e yaz
 *   4. Planda erişilemez → fail-closed (reject)
 */
export interface AuthResult {
    valid: boolean;
    userId?: string;
}
/**
 * Validate that `token` is the Planda Sanctum token for `userId`.
 *
 * Returns valid=true only when Planda /marketplace/clients/{userId}
 * answers 200 with the bearer header. 401/403/404/timeout → invalid.
 */
export declare function validatePlandaToken(token: string, userId: string): Promise<AuthResult>;
//# sourceMappingURL=auth.d.ts.map