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
/**
 * Normalized district keyword → parent city display form.
 * Lowercase, diacritic-stripped; matches come from normTR(userInput).
 */
export const DISTRICT_TO_CITY = {
    // İstanbul — Anadolu Yakası ilçeleri + semtleri
    "kadikoy": "İstanbul",
    "goztepe": "İstanbul",
    "bagdat caddesi": "İstanbul",
    "kozyatagi": "İstanbul",
    "suadiye": "İstanbul",
    "caddebostan": "İstanbul",
    "moda": "İstanbul",
    "bostanci": "İstanbul",
    "uskudar": "İstanbul",
    "atasehir": "İstanbul",
    "maltepe": "İstanbul",
    "kartal": "İstanbul",
    "pendik": "İstanbul",
    "tuzla": "İstanbul",
    "cekmekoy": "İstanbul",
    "umraniye": "İstanbul",
    // İstanbul — Avrupa Yakası ilçeleri + semtleri
    "besiktas": "İstanbul",
    "sisli": "İstanbul",
    "beyoglu": "İstanbul",
    "sariyer": "İstanbul",
    "bakirkoy": "İstanbul",
    "bahcelievler": "İstanbul",
    "beylikduzu": "İstanbul",
    "fatih": "İstanbul",
    "zeytinburnu": "İstanbul",
    "basaksehir": "İstanbul",
    "esenler": "İstanbul",
    "kagithane": "İstanbul",
    "eyupsultan": "İstanbul",
    "nisantasi": "İstanbul",
    "etiler": "İstanbul",
    "levent": "İstanbul",
    "mecidiyekoy": "İstanbul",
    // Ankara
    "cankaya": "Ankara",
    "yenimahalle": "Ankara",
    "kecioren": "Ankara",
    "mamak": "Ankara",
    "etimesgut": "Ankara",
    "sincan": "Ankara",
    "altindag": "Ankara",
    "kizilay": "Ankara",
    "tunali": "Ankara",
    "cayyolu": "Ankara",
    "umitkoy": "Ankara",
    // İzmir
    "konak": "İzmir",
    "karsiyaka": "İzmir",
    "bornova": "İzmir",
    "buca": "İzmir",
    "cigli": "İzmir",
    "bayrakli": "İzmir",
    "gaziemir": "İzmir",
    "alsancak": "İzmir",
    "guzelbahce": "İzmir",
};
/**
 * İstanbul side map — used to enforce the "Boğaz kuralı" at server level:
 * when a user asks for a European-side district, don't return Asian-side
 * branches (and vice-versa). Cross-side recommendations are invalid.
 */
const ISTANBUL_SIDE = {
    // Anadolu
    kadikoy: "anadolu", goztepe: "anadolu", "bagdat caddesi": "anadolu",
    kozyatagi: "anadolu", suadiye: "anadolu", caddebostan: "anadolu",
    moda: "anadolu", bostanci: "anadolu", uskudar: "anadolu",
    atasehir: "anadolu", maltepe: "anadolu", kartal: "anadolu",
    pendik: "anadolu", tuzla: "anadolu", cekmekoy: "anadolu",
    umraniye: "anadolu",
    // Avrupa
    besiktas: "avrupa", sisli: "avrupa", beyoglu: "avrupa",
    sariyer: "avrupa", bakirkoy: "avrupa", bahcelievler: "avrupa",
    beylikduzu: "avrupa", fatih: "avrupa", zeytinburnu: "avrupa",
    basaksehir: "avrupa", esenler: "avrupa", kagithane: "avrupa",
    eyupsultan: "avrupa", nisantasi: "avrupa", etiler: "avrupa",
    levent: "avrupa", mecidiyekoy: "avrupa",
};
/** Which side of İstanbul is this normalized district on? */
export function istanbulSide(district) {
    return ISTANBUL_SIDE[normTR(district)] ?? null;
}
/**
 * Resolve a free-form city / district input against the known map.
 *
 *   "Göztepe"   → { city: "İstanbul", district: "goztepe" }
 *   "Kadıköy"   → { city: "İstanbul", district: "kadikoy" }
 *   "İstanbul"  → { city: "İstanbul", district: null }
 *   "Mersin"    → { city: "Mersin",   district: null }  (unknown → pass through)
 */
export function resolveLocation(input) {
    const normalized = normTR(input);
    const parentCity = DISTRICT_TO_CITY[normalized];
    if (parentCity) {
        return { city: parentCity, district: normalized, inputWasCity: false };
    }
    return { city: input, district: null, inputWasCity: true };
}
/**
 * Check whether a therapist has a physical branch that matches the given
 * district keyword. Matches both `branches[].name` and `branches[].address`,
 * so "goztepe" resolves whether the branch label is "Göztepe" (as `name`)
 * or the district appears in the free-text address.
 */
export function therapistInDistrict(t, district) {
    const target = normTR(district);
    if (!target)
        return false;
    return (t.branches ?? []).some((b) => {
        if (!b || b.type !== "physical")
            return false;
        const name = normTR(b.name ?? "");
        const addr = normTR(b.address ?? "");
        return name.includes(target) || addr.includes(target);
    });
}
/**
 * When the user targets a specific İstanbul side, filter out therapists
 * whose ONLY physical presence is on the opposite side. Online-only
 * branches never count against a side match.
 */
export function matchesIstanbulSide(t, requestedSide) {
    const physical = (t.branches ?? []).filter((b) => b?.type === "physical");
    if (physical.length === 0)
        return false;
    for (const b of physical) {
        const branchName = normTR(b.name ?? "");
        const side = ISTANBUL_SIDE[branchName];
        if (side === requestedSide)
            return true;
    }
    return false;
}
//# sourceMappingURL=locationNormalizer.js.map