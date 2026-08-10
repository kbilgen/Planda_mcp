/**
 * Lightweight intent classifier — keyword-based, zero latency.
 *
 * Used to annotate conversation logs and detect "tool call expected but missing"
 * regressions (e.g. therapist search intent without find_therapists call).
 */
import { DISTRICT_TO_CITY } from "../services/locationNormalizer.js";
const NORMALIZE = (s) => s.toLowerCase()
    .replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u")
    .replace(/ö/g, "o").replace(/ı/g, "i").replace(/ç/g, "c")
    .replace(/İ/g, "i").replace(/I/g, "i");
const SEARCH_KEYS = [
    "terapist", "psikolog", "psikiyatr", "uzman", "danisman", "therapist",
    "ariyorum", "oneri", "onerir", "bul", "yardim", "destek ariyorum",
    "anksiyete", "kaygi", "depresyon", "panik", "travma", "stres", "burnout",
    "iliski", "evlilik", "cift", "ergen", "cocuk", "aile",
    "online terapi", "yuz yuze", "seans",
];
// Availability keywords — strict phrase matching to avoid ambiguity.
//
// "uygun" alone is NOT here because it also means "suitable" in Turkish:
//   "uygun saat"     → availability ✓
//   "uygun terapist" → search (suitable therapist) ✗
// So we require "uygun" to appear together with a time word.
//
// Similarly "hangi gun / saat" is availability but "hangi terapist / psikolog"
// is search — disambiguated via the SEARCH_HANGI_PHRASES list below.
const AVAIL_PHRASES = [
    "musait", "musaitlik", "randevu",
    "uygun saat", "uygun gun", "uygun tarih", "uygun zaman",
    "hangi gun", "hangi saat", "hangi tarih",
    "ne zaman",
];
// Day/time context words that can push a message to availability when paired
// with a weak signal (e.g. "yarın" alone isn't availability but "yarın müsait"
// definitely is; "pazartesi için saat" is availability).
const TIME_WORDS = [
    "saat", "tarih", "hafta", "yarin",
    "pazartesi", "sali", "carsamba", "persembe", "cuma", "cumartesi", "pazar",
];
// Explicit search-intent phrases that contain the "hangi" disambiguator — these
// are search, NOT availability, even if AVAIL_PHRASES partially matches later.
const SEARCH_HANGI_PHRASES = [
    "hangi terapist", "hangi psikolog", "hangi uzman", "hangi danisman",
];
// Presence-lookup cues — "X burada mı", "sizde X var mı", "X kim?".
// The capitalized NAME_LOOKUP_RE at the bottom of classifyIntent misses
// lowercase mobile typing ("gülşah gürel burada mı"), which left the model
// free to answer without a tool call and then get killed by the guard
// (prod bug, 2026-08-10). These cues run on normalized text, so casing
// and diacritics don't matter. Multi-word phrases are substring-matched;
// single-word cues ("kim") are word-matched to avoid "hekim"/"kimlik" hits.
const PRESENCE_PHRASES = [
    "burada mi", "burda mi",
    "kayitli mi", "calisiyor mu", "hizmet veriyor mu",
];
const PRESENCE_WORD_CUES = ["kim", "kimdir"];
// "sizde X var mı" splits the cue around the name, so the phrase list can't
// catch it. Instead: a context word ("sizde", "planda", …) anywhere in the
// message combined with "var mı" counts as a presence cue.
const PRESENCE_CONTEXT_WORDS = [
    "sizde", "planda", "plandada", "aranizda",
    "listede", "listenizde", "burada", "burda",
];
// Words that belong to the cue/grammar, not to a therapist name — removed
// before deciding whether a presence query actually contains a name.
const PRESENCE_STOPWORDS = new Set([
    "burada", "burda", "sizde", "planda", "plandada", "aranizda",
    "listede", "listenizde", "kayitli", "calisiyor", "hizmet", "veriyor",
    "var", "yok", "mi", "mu", "kim", "kimdir", "hala", "acaba", "peki",
    "hic", "diye", "isimli", "adinda", "biri", "birisi", "su", "bu", "o",
    "bey", "hanim", "hn", "dr",
    "terapist", "psikolog", "uzman", "danisman", "doktor", "hoca",
]);
const DETAIL_KEYS = [
    "bdt", "emdr", "act", "schema", "sema", "bilissel", "davranisci",
    "yaklasim", "yontem", "hakkinda", "profil", "deneyim", "egitim",
];
const SPECIALTY_KEYS = [
    "uzmanlik alanlari", "hangi konular", "ne tur terapi", "specialties",
];
const GREETING_KEYS = [
    "merhaba", "selam", "hey", "hi", "hello", "iyi gunler", "gunaydin", "iyi aksamlar",
];
const CLARIFY_KEYS = [
    "emin misin", "dogru mu", "gercek mi", "hala musait", "bu dogru",
    "evet", "hayir", "tamam", "peki",
];
// Meta / explanation request phrases — user asking HOW/WHY the model made a
// previous choice. These are high-risk for meta-hallucination: the model
// tends to fabricate a methodology ("approaches[]'e baktım") when in fact
// no tool was called. Seen in Sentry event f7c0f3e9 (2026-04-23).
//
// Policy: route to `explanation_request` so the response guard knows this
// turn MUST either re-call get_therapist / find_therapists OR answer with a
// honest "I need to re-verify" fallback — never fabricate methodology.
const EXPLANATION_PHRASES = [
    "nasil sectin", "nasil sectiniz", "nasil buldun", "nasil buldunuz",
    "neye gore", "hangi kritere", "hangi kriter", "hangi kritere gore",
    "hangi olcute", "ne olcutle", "hangi baz", "kaynagin", "kaynagi ne",
    "nerden biliyorsun", "nereden biliyorsun", "neye dayanarak",
    "ne olcu", "hangi veri", "hangi bilgiyle",
];
function hasAny(haystack, keys) {
    return keys.filter((k) => haystack.includes(k));
}
export function classifyIntent(message, history) {
    const n = NORMALIZE(message.trim());
    if (!n)
        return { intent: "unknown", expectedTools: [], matched: [] };
    // Disambiguation step 0: explanation / meta-justification requests.
    // Runs first because "BDT olanları neye göre seçtin" contains the DETAIL
    // keyword "bdt" but is really an explanation request, not a detail lookup.
    // Expected tools: get_therapist AND find_therapists — the model must
    // re-consult the API to answer honestly, OR fall back to a candid reply.
    const explanationMatches = hasAny(n, EXPLANATION_PHRASES);
    if (explanationMatches.length) {
        return {
            intent: "explanation_request",
            expectedTools: ["find_therapists", "get_therapist"],
            matched: explanationMatches,
        };
    }
    // Disambiguation step 0.5: continuation of an earlier clarification.
    //
    // If the last assistant turn ended with a question ("Hangi şehirdesin?")
    // the user's next message is almost certainly answering it — not starting
    // a brand-new search intent. Without this check, short replies like
    // "İstanbul Kartal" or "30 yaşındayım" get flagged as search_therapist
    // with forceToolCall=true, producing fallback messages when the model
    // can't ground a full search from one fragment (NODE-3).
    //
    // Runs AFTER explanation_request because meta-questions take priority
    // regardless of whether the previous turn was a question.
    if (history && history.length > 0) {
        for (let i = history.length - 1; i >= 0; i--) {
            const prev = history[i];
            if (prev.role !== "assistant")
                continue;
            if (prev.content.trim().endsWith("?")) {
                return {
                    intent: "clarification",
                    expectedTools: [],
                    matched: ["continuation_of_question"],
                };
            }
            break; // only consider the MOST RECENT assistant turn
        }
    }
    // Disambiguation step 1: "hangi terapist/psikolog/uzman" is ALWAYS search,
    // even if other availability phrases follow. Check this first so an
    // accidental "uygun" or "saat" later in the sentence can't redirect.
    const searchHangi = hasAny(n, SEARCH_HANGI_PHRASES);
    if (searchHangi.length) {
        const detailMatches = hasAny(n, DETAIL_KEYS);
        return {
            intent: "search_therapist",
            expectedTools: detailMatches.length
                ? ["find_therapists", "get_therapist"]
                : ["find_therapists"],
            matched: [...searchHangi, ...detailMatches],
        };
    }
    // Availability: a phrase from AVAIL_PHRASES (already disambiguated).
    // Time words alone ("yarın") aren't enough — they need a stronger signal.
    const availPhraseMatches = hasAny(n, AVAIL_PHRASES);
    const timeWordMatches = hasAny(n, TIME_WORDS);
    const isAvailability = availPhraseMatches.length > 0 ||
        // "yarın var mı / uygun mu" style — time word + question marker
        (timeWordMatches.length > 0 && (n.includes(" var mi") || n.includes(" var?") || n.endsWith("var mi")));
    if (isAvailability) {
        return {
            intent: "check_availability",
            expectedTools: ["get_therapist_available_days", "get_therapist_hours"],
            matched: [...availPhraseMatches, ...timeWordMatches],
        };
    }
    const specialtyMatches = hasAny(n, SPECIALTY_KEYS);
    if (specialtyMatches.length) {
        return {
            intent: "list_specialties",
            expectedTools: ["list_specialties"],
            matched: specialtyMatches,
        };
    }
    // Presence / lowercase name-lookup: "gülşah gürel burada mı", "sizde ayşe
    // demir var mı", "ahmet yılmaz kim?". Requires a cue AND at least one
    // residual (non-stopword) token that can plausibly be a name — a bare
    // "burada mı?" without a name falls through to the other branches.
    const nClean = n.replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    const cleanWords = nClean.split(" ").filter(Boolean);
    const presenceCue = PRESENCE_PHRASES.find((p) => nClean.includes(p)) ??
        (nClean.includes("var mi") &&
            PRESENCE_CONTEXT_WORDS.some((w) => cleanWords.includes(w))
            ? "var mi (contextual)"
            : null) ??
        PRESENCE_WORD_CUES.find((c) => cleanWords.includes(c)) ??
        null;
    if (presenceCue) {
        const nameWords = cleanWords.filter((w) => w.length >= 2 && !PRESENCE_STOPWORDS.has(w));
        if (nameWords.length >= 1) {
            return {
                intent: "search_therapist",
                expectedTools: ["find_therapists"],
                matched: [presenceCue, ...nameWords.slice(0, 4)],
            };
        }
    }
    // Search vs. detail: if both search+detail keywords present, it's a filtered
    // search ("BDT yapan terapist istiyorum"), not a detail lookup.
    const searchMatches = hasAny(n, SEARCH_KEYS);
    const detailMatches = hasAny(n, DETAIL_KEYS);
    // "Specific enough to search": must contain at least one of
    // specialty / city / approach / service qualifier. Otherwise it's a vague
    // request like "terapi arıyorum" / "kendim için psikolog arıyorum" where
    // the correct behavior is to ask a clarifying question, not call tools.
    const SPECIFICITY_KEYS = [
        "anksiyete", "kaygi", "depresyon", "panik", "travma", "stres", "burnout",
        "iliski", "evlilik", "cift", "ergen", "cocuk", "aile",
        "istanbul", "ankara", "izmir", "bursa", "antalya",
        "online", "yuz yuze",
    ];
    // District names count as location specificity too — "bakırköyde uzman bul"
    // is as actionable as "istanbulda terapist" (the tool layer resolves the
    // district to its parent city). Substring match tolerates Turkish locative
    // suffixes ("bakirkoyde" contains "bakirkoy").
    const districtMatches = Object.keys(DISTRICT_TO_CITY).filter((d) => n.includes(d));
    const specificity = hasAny(n, [...SPECIFICITY_KEYS, ...DETAIL_KEYS]);
    const hasEnoughInfo = specificity.length > 0 || districtMatches.length > 0;
    if (searchMatches.length && detailMatches.length) {
        return {
            intent: "search_therapist",
            expectedTools: ["find_therapists", "get_therapist"],
            matched: [...searchMatches, ...detailMatches],
        };
    }
    if (detailMatches.length) {
        return {
            intent: "therapist_detail",
            expectedTools: ["get_therapist"],
            matched: detailMatches,
        };
    }
    if (searchMatches.length) {
        return {
            intent: "search_therapist",
            // Vague searches expect a clarifying question, not a tool call
            expectedTools: hasEnoughInfo ? ["find_therapists"] : [],
            matched: searchMatches,
        };
    }
    const clarify = hasAny(n, CLARIFY_KEYS);
    if (clarify.length) {
        return { intent: "clarification", expectedTools: [], matched: clarify };
    }
    const greet = hasAny(n, GREETING_KEYS);
    if (greet.length && n.length < 30) {
        return { intent: "greeting", expectedTools: [], matched: greet };
    }
    // Out-of-scope heuristic: coding, law, recipes, etc.
    const oosKeys = ["kod yaz", "recete", "tarif", "hukuk", "borsa", "python", "javascript"];
    const oos = hasAny(n, oosKeys);
    if (oos.length)
        return { intent: "out_of_scope", expectedTools: [], matched: oos };
    // Name-lookup pattern — two or more consecutive Turkish-capitalized words
    // ("Ekin Alankuş kim?", "Ayşe Nur Çelik hakkında bilgi"). Runs LAST so that
    // search/availability intents take priority when their keywords are present
    // ("Ayşe Nur Çelik bu hafta müsait mi" → check_availability via "müsait").
    // Operates on the ORIGINAL message (case preserved).
    const NAME_LOOKUP_RE = /[A-ZÇĞİÖŞÜ][a-zçğıöşü]+(?:\s+[A-ZÇĞİÖŞÜ][a-zçğıöşü]+)+/;
    const nameMatch = message.match(NAME_LOOKUP_RE);
    if (nameMatch) {
        return {
            intent: "search_therapist",
            expectedTools: ["find_therapists"],
            matched: [nameMatch[0]],
        };
    }
    return { intent: "unknown", expectedTools: [], matched: [] };
}
/**
 * Returns true when the classifier is confident a tool call is required —
 * used to flip Runner.modelSettings.toolChoice to "required" for this turn.
 *
 * Only fires for search/availability intents with enough context; vague
 * searches ("terapi arıyorum") are left on auto so the model can ask
 * clarifying questions.
 */
export function shouldForceToolCall(intent) {
    // Non-empty expectedTools = classifier thinks the model should call a tool.
    // This is already gated by hasEnoughInfo in classifyIntent for searches.
    if (intent.expectedTools.length === 0)
        return false;
    // Only force for search flows. Availability questions usually already
    // reach the tool; forcing there has less marginal value and risks
    // false-forcing on reconfirmation chit-chat ("emin misin?").
    return intent.intent === "search_therapist";
}
/**
 * Returns violations when expected tools were not called.
 *
 * Ignores the mismatch when the assistant responded with a clarifying question
 * (ends with "?" or contains a common Turkish clarifier) — asking for more info
 * before searching is a legitimate flow per the system prompt.
 */
export function detectIntentToolMismatch(intent, actualToolCalls, response) {
    if (intent.expectedTools.length === 0)
        return [];
    const called = new Set(actualToolCalls);
    const missing = intent.expectedTools.filter((t) => !called.has(t));
    if (missing.length < intent.expectedTools.length)
        return [];
    // Clarification heuristic — response asks a question before searching
    if (response) {
        const trimmed = response.trim();
        const lastChar = trimmed.slice(-1);
        const lower = trimmed.toLowerCase();
        const clarifierPhrases = [
            "paylaşabilir misin", "paylasabilir misin",
            "söyleyebilir misin", "soyleyebilir misin",
            "hangi konu", "hangi şehir", "hangi sehir",
            "kimin için", "kimin icin",
            "ne tür", "ne tur",
            "kaç yaş", "kac yas",
            "online mi", "yüz yüze mi", "yuz yuze mi",
            // Meta-explanation honest-fallback phrases — when the model correctly
            // refuses to fabricate methodology and asks to re-verify instead.
            "tekrar doğrulama", "tekrar dogrulama",
            "güncel listeye", "guncel listeye",
            "net hatırlamıyorum", "net hatirlamiyorum",
            "tekrar öneri", "tekrar oneri",
        ];
        if (lastChar === "?" || clarifierPhrases.some((p) => lower.includes(p))) {
            return [];
        }
    }
    return [`expected one of [${intent.expectedTools.join(", ")}] but got [${actualToolCalls.join(", ") || "none"}]`];
}
//# sourceMappingURL=intentClassifier.js.map