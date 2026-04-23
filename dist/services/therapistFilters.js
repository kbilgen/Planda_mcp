/**
 * Therapist list filter helpers — applied server-side inside tool handlers
 * so the model's filter intent becomes an authoritative contract instead
 * of a post-hoc AI-side cleanup.
 *
 * All helpers are pure, Turkish-aware, and bound-safe on empty inputs.
 */
/** Lower-case + strip Turkish diacritics + trim to ASCII alnum + spaces. */
function normTR(s) {
    return s
        // Turkish uppercase İ (U+0130) → "i" BEFORE default toLowerCase,
        // because JS toLowerCase on İ yields "i̇" (combining dot) which
        // later gets stripped to "i " (space) breaking match.
        .replace(/İ/g, "i")
        .replace(/I/g, "i")
        .toLowerCase()
        .replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u")
        .replace(/ö/g, "o").replace(/ı/g, "i").replace(/ç/g, "c")
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
/** Therapist has at least one online branch. */
export function matchesOnline(t) {
    return (t.branches ?? []).some((b) => b.type === "online");
}
/** Therapist has at least one physical branch (optionally in a specific city). */
export function matchesPhysical(t, city) {
    const branches = (t.branches ?? []).filter((b) => b.type === "physical");
    if (!branches.length)
        return false;
    if (!city)
        return true;
    const target = normTR(city);
    return branches.some((b) => b.city?.name && normTR(b.city.name) === target);
}
/** Therapist's lowest priced service is <= maxFee (TL). */
export function matchesMaxFee(t, maxFee) {
    const fees = (t.services ?? [])
        .map((s) => {
        const raw = s.custom_fee ?? s.fee;
        if (!raw)
            return null;
        const n = parseFloat(raw);
        return Number.isFinite(n) ? n : null;
    })
        .filter((n) => n !== null);
    if (!fees.length)
        return false;
    return Math.min(...fees) <= maxFee;
}
/** Therapist's top-level or data.gender equals the requested gender. */
export function matchesGender(t, gender) {
    const g = t.gender ?? t.data?.gender;
    return g === gender;
}
/**
 * Fuzzy name match — returns therapists whose full_name / name+surname /
 * username contains all query words (normalized, Turkish-insensitive).
 *
 *   filterByFuzzyName(list, "Ekin Alankuş")     → matches "Ekin Alankuş"
 *   filterByFuzzyName(list, "ayse demir")       → matches "Ayşe Demir"
 *   filterByFuzzyName(list, "ekin alankus")     → same
 *   filterByFuzzyName(list, "alankus")          → any with "alankus" in name
 */
export function filterByFuzzyName(list, query) {
    const words = normTR(query).split(" ").filter((w) => w.length >= 2);
    if (!words.length)
        return list;
    return list.filter((t) => {
        const full = t.full_name?.trim() || [t.name, t.surname].filter(Boolean).join(" ");
        const haystack = normTR(`${full} ${t.username ?? ""}`);
        return words.every((w) => haystack.includes(w));
    });
}
/**
 * Apply all configured filters in order. Returns the filtered list.
 * Order matters for composability: name first (narrowing), then attributes.
 */
export function applyAiSideFilters(list, f) {
    let out = list;
    if (f.name)
        out = filterByFuzzyName(out, f.name);
    if (f.online === true)
        out = out.filter(matchesOnline);
    if (f.online === false)
        out = out.filter((t) => matchesPhysical(t, f.city));
    if (f.gender)
        out = out.filter((t) => matchesGender(t, f.gender));
    if (typeof f.max_fee === "number")
        out = out.filter((t) => matchesMaxFee(t, f.max_fee));
    return out;
}
//# sourceMappingURL=therapistFilters.js.map