/**
 * Planda Auth — Token Validation
 *
 * Laravel Sanctum formatı: "{id}|{token}" — lokal doğrulama imkansız.
 * Planda API'ye sorarak validate eder, sonucu Redis'e 5dk cache'ler.
 *
 * Akış:
 *   1. Redis cache'e bak → hit ise anında dön (~1ms)
 *   2. Miss ise Planda /marketplace/user endpoint'ini çağır (~200ms)
 *   3. Başarılıysa sonucu cache'e yaz, döndür
 *   4. Planda 401 → { valid: false }
 *   5. Planda erişilemez → { valid: false } (fail-closed, güvenli taraf)
 */
export interface AuthResult {
    valid: boolean;
    userId?: string;
}
export declare function validatePlandaToken(token: string): Promise<AuthResult>;
//# sourceMappingURL=auth.d.ts.map