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

import crypto from "crypto";
import { getRedis } from "./sessionStore.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const PLANDA_BASE = "https://app.planda.org/api/v1";

// Hangi endpoint'e bakacağız? Sanctum'da genelde /user veya /me
// PLANDA_AUTH_ENDPOINT env var ile override edilebilir
const VALIDATE_URL =
  process.env.PLANDA_AUTH_ENDPOINT ?? `${PLANDA_BASE}/marketplace/user`;

const CACHE_TTL_SEC = 5 * 60;   // 5 dakika — token geçerliyse bu kadar cache'le
const REQUEST_TIMEOUT_MS = 5000; // 5 saniye — Planda API cevap vermezse vazgeç

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Token'ı cache key'i için SHA-256 ile hash'le — tokeni Redis'e düz yazmıyoruz */
function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 32);
}

export interface AuthResult {
  valid: boolean;
  userId?: string;
}

// ─── Validate ────────────────────────────────────────────────────────────────

export async function validatePlandaToken(token: string): Promise<AuthResult> {
  const redis = getRedis();
  const cacheKey = `planda:auth:${tokenHash(token)}`;

  // 1. Redis cache kontrolü
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as AuthResult;
      }
    } catch (err) {
      console.warn("[auth] Redis cache read error:", (err as Error).message);
    }
  }

  // 2. Planda API'ye sor
  let result: AuthResult;
  try {
    const res = await fetch(VALIDATE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.ok) {
      const body = (await res.json()) as Record<string, unknown>;
      // Planda user ID: data.id veya direkt id
      const uid =
        String(
          (body?.data as Record<string, unknown>)?.id ??
          body?.id ??
          "unknown"
        );
      result = { valid: true, userId: uid };
    } else {
      result = { valid: false };
    }
  } catch (err) {
    // Timeout veya network hatası → fail-closed (reddet)
    console.warn("[auth] Planda token validation failed:", (err as Error).message);
    result = { valid: false };
  }

  // 3. Başarılıysa Redis'e cache'le
  if (redis && result.valid) {
    try {
      await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL_SEC);
    } catch (err) {
      console.warn("[auth] Redis cache write error:", (err as Error).message);
    }
  }

  return result;
}
