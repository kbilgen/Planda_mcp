/**
 * Server-side approach verification.
 *
 * The Planda list endpoint does NOT include `approaches[]` — only the detail
 * endpoint does. The model is supposed to call get_therapist for each
 * candidate when the user asks for a specific approach (BDT, EMDR, etc.)
 * but gpt-4.1-mini reliably skips that step under prompt pressure.
 *
 * This module fills the gap on the server side: given a list of candidates
 * and an approach query, it fetches `approaches[]` for each (in parallel,
 * with a 5-min cache), and returns only therapists whose approaches[]
 * actually contain the requested keyword.
 *
 * The model can no longer cause "BDT yapan terapist yok" false negatives
 * by forgetting the second tool call.
 */
import { getTherapist } from "./therapistApi.js";
const TTL_MS = 5 * 60 * 1000;
const cache = new Map();
function cacheGet(id) {
    const entry = cache.get(id);
    if (!entry)
        return null;
    if (Date.now() - entry.fetchedAt > TTL_MS) {
        cache.delete(id);
        return null;
    }
    return entry.approaches;
}
function cacheSet(id, approaches) {
    cache.set(id, { approaches, fetchedAt: Date.now() });
}
// ─── Approach keyword normalization ──────────────────────────────────────────
//
// Maps user-side keywords (lowercase, diacritic-stripped) to substrings that
// should appear in therapist.approaches[].name (also normalized). One user
// keyword can have multiple acceptable substrings — e.g. "bdt" matches both
// "bilissel davranisci" and "cbt".
function normTR(s) {
    return s
        .replace(/İ/g, "i")
        .replace(/I/g, "i")
        .toLowerCase()
        .replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u")
        .replace(/ö/g, "o").replace(/ı/g, "i").replace(/ç/g, "c")
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
const APPROACH_RULES = [
    { userKeys: ["bdt", "cbt", "bilissel", "davranisci"], therapistSubstr: ["bilissel davranisci", "bdt", "cbt"] },
    { userKeys: ["emdr"], therapistSubstr: ["emdr"] },
    { userKeys: ["act", "kabul ve kararlilik"], therapistSubstr: ["act", "kabul ve kararlilik"] },
    { userKeys: ["dbt", "dialektik"], therapistSubstr: ["dbt", "dialektik"] },
    { userKeys: ["sema", "schema"], therapistSubstr: ["sema terapi", "schema"] },
    { userKeys: ["gestalt"], therapistSubstr: ["gestalt"] },
    { userKeys: ["psikanaliz", "psikodinamik"], therapistSubstr: ["psikanali", "psikodinamik"] },
    { userKeys: ["mindfulness", "farkindalik"], therapistSubstr: ["mindfulness", "farkindalik"] },
    { userKeys: ["sistemik"], therapistSubstr: ["sistemik"] },
    { userKeys: ["duygu odakli", "eft"], therapistSubstr: ["duygu odakli", "eft"] },
    { userKeys: ["oyun terapi", "oyun terapisi"], therapistSubstr: ["oyun terapi"] },
    { userKeys: ["sanat terapi"], therapistSubstr: ["sanat terapi"] },
];
/** Resolve a free-form approach query to the substrings that match. */
function approachSubstrings(query) {
    const q = normTR(query);
    if (!q)
        return [];
    for (const rule of APPROACH_RULES) {
        if (rule.userKeys.some((k) => q.includes(k)))
            return rule.therapistSubstr;
    }
    // Unknown approach — fall back to the literal query (still substring match).
    return [q];
}
/** Does the therapist's approaches[] satisfy the query? */
function approachMatches(approaches, query) {
    const subs = approachSubstrings(query);
    if (subs.length === 0)
        return false;
    for (const a of approaches) {
        const n = normTR(a?.name ?? "");
        if (!n)
            continue;
        if (subs.some((s) => n.includes(s)))
            return true;
    }
    return false;
}
// ─── Public API ──────────────────────────────────────────────────────────────
/**
 * Fetch the approaches[] list for a single therapist. Uses cache when fresh,
 * otherwise hits get_therapist. On any error returns an empty list — callers
 * treat that as "not verified, exclude" rather than crashing.
 */
async function fetchApproaches(id) {
    const cached = cacheGet(id);
    if (cached)
        return cached;
    try {
        const raw = (await getTherapist(id));
        // Planda's standard detail shape has Therapist fields at the top level
        // AND a nested `data` sub-object with extras (title_id, introduction_letter,
        // etc). approaches[] lives at the top level, so prefer raw.approaches and
        // only unwrap raw.data if the response is a thin { data: Therapist } wrapper.
        const looksLikeTherapist = Array.isArray(raw.approaches) ||
            Array.isArray(raw.branches) ||
            typeof raw.full_name === "string" ||
            typeof raw.username === "string";
        const t = looksLikeTherapist
            ? raw
            : (raw.data ?? raw);
        const merged = Array.isArray(t.approaches) ? t.approaches : [];
        cacheSet(id, merged);
        return merged;
    }
    catch {
        return [];
    }
}
/**
 * Filter `candidates` to therapists whose approaches[] contains the requested
 * approach. Concurrency is bounded so we don't hammer the Planda API when
 * there are many candidates; 5 in-flight requests is plenty for a roster of
 * ~60 therapists.
 *
 * Therapists with no approaches[] data (empty or fetch-failed) are EXCLUDED
 * — we never recommend an approach we can't prove. If the user's question
 * was about a specific approach and we can't verify, returning fewer
 * (correct) results is better than padding with unverified ones.
 */
export async function filterByApproachVerified(candidates, query, concurrency = 5) {
    if (candidates.length === 0 || !query.trim())
        return [];
    // Bounded parallel fetch
    const indexed = candidates.map((t, i) => ({ t, i }));
    const results = new Array(candidates.length);
    let cursor = 0;
    const workers = [];
    for (let w = 0; w < Math.min(concurrency, candidates.length); w++) {
        workers.push((async () => {
            while (true) {
                const idx = cursor++;
                if (idx >= indexed.length)
                    return;
                const { t, i } = indexed[idx];
                if (t.id == null) {
                    results[i] = { t, matches: false };
                    continue;
                }
                const approaches = await fetchApproaches(t.id);
                // Inject approaches into the therapist record so downstream code
                // (markdown renderer, Eşleşme block) can show them without another
                // fetch.
                if (approaches.length > 0)
                    t.approaches = approaches;
                results[i] = { t, matches: approachMatches(approaches, query) };
            }
        })());
    }
    await Promise.all(workers);
    return results.filter((r) => r.matches).map((r) => r.t);
}
/** Test-only — exposed for unit tests, not part of the runtime contract. */
export const __test__ = { approachSubstrings, approachMatches, normTR };
//# sourceMappingURL=approachVerifier.js.map