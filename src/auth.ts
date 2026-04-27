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

import crypto from "crypto";
import { getRedis } from "./sessionStore.js";

const PLANDA_BASE = "https://app.planda.org/api/v1";

// Validation endpoint template — {userId} is replaced with the value from
// X-User-ID. PLANDA_AUTH_ENDPOINT_TEMPLATE env var override allows pointing
// at a different "verify this user owns this token" route if needed.
const VALIDATE_TEMPLATE =
  process.env.PLANDA_AUTH_ENDPOINT_TEMPLATE ??
  `${PLANDA_BASE}/marketplace/clients/{userId}`;

const CACHE_TTL_SEC = 5 * 60;
const REQUEST_TIMEOUT_MS = 5000;

// userId comes from a client header — must be a positive integer before
// we splice it into a URL path. Rejects empty / negative / non-numeric.
const USER_ID_RE = /^[1-9]\d{0,9}$/;

/** Hash (token + userId) for the cache key — never store raw token. */
function cacheKey(token: string, userId: string): string {
  const h = crypto.createHash("sha256").update(`${token}:${userId}`).digest("hex").slice(0, 32);
  return `planda:auth:${h}`;
}

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
export async function validatePlandaToken(
  token: string,
  userId: string
): Promise<AuthResult> {
  if (!USER_ID_RE.test(userId)) return { valid: false };

  const redis = getRedis();
  const key = cacheKey(token, userId);

  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached) return JSON.parse(cached) as AuthResult;
    } catch (err) {
      console.warn("[auth] Redis cache read error:", (err as Error).message);
    }
  }

  const url = VALIDATE_TEMPLATE.replace("{userId}", userId);
  let result: AuthResult;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.ok) {
      // 200 means: this token belongs to (or is allowed to read) userId.
      // For client endpoint, Sanctum + policy ensures only the owner gets 200.
      result = { valid: true, userId };
    } else {
      // 401 invalid token, 403 impersonation, 404 unknown user — all reject.
      result = { valid: false };
    }
  } catch (err) {
    console.warn("[auth] Planda token validation failed:", (err as Error).message);
    result = { valid: false };
  }

  if (redis && result.valid) {
    try {
      await redis.set(key, JSON.stringify(result), "EX", CACHE_TTL_SEC);
    } catch (err) {
      console.warn("[auth] Redis cache write error:", (err as Error).message);
    }
  }

  return result;
}
