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
    "florya": "İstanbul",
    "yesilkoy": "İstanbul",
    "yesilyurt": "İstanbul",
    "atakoy": "İstanbul",
    "senlikkoy": "İstanbul",
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
    // İstanbul — Avrupa (dış çeper)
    "silivri": "İstanbul",
    // Antalya (gerçek trafik: "Konyaaltına en yakın ilçede var mı", 2026-08)
    "konyaalti": "Antalya",
    "muratpasa": "Antalya",
    "lara": "Antalya",
    "kepez": "Antalya",
    // Kocaeli (gerçek trafik: "Gebze darıca tarafı")
    "gebze": "Kocaeli",
    "darica": "Kocaeli",
    "izmit": "Kocaeli",
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
    florya: "avrupa", yesilkoy: "avrupa", yesilyurt: "avrupa",
    atakoy: "avrupa", senlikkoy: "avrupa", silivri: "avrupa",
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
/**
 * İlçe → semt aliases. Branch labels often carry the semt, not the ilçe
 * ("Florya" branch, "Şenlikköy Mah." address — both are Bakırköy), so a
 * user asking for the ilçe must also match branches labelled by its semts.
 */
const DISTRICT_SUBAREAS = {
    bakirkoy: ["florya", "yesilkoy", "yesilyurt", "atakoy", "senlikkoy"],
    kadikoy: ["moda", "goztepe", "kozyatagi", "suadiye", "caddebostan", "bostanci", "fenerbahce"],
    sisli: ["nisantasi", "mecidiyekoy"],
    besiktas: ["etiler", "levent", "ortakoy", "bebek"],
};
/**
 * Same-side district adjacency. LLMs recall geography probabilistically —
 * small models routinely call Kadıköy "near Bakırköy" (opposite sides of the
 * Bosphorus). Branch lat/lng in the Planda API is currently null, so real
 * distance math isn't possible; this static map is the deterministic
 * substitute. Every listed neighbour is on the same side as its key, so the
 * Boğaz rule can never be violated by construction.
 */
const NEARBY_DISTRICTS = {
    // İstanbul — Avrupa
    bakirkoy: ["bahcelievler", "zeytinburnu", "fatih"],
    bahcelievler: ["bakirkoy", "basaksehir", "esenler", "beylikduzu"],
    zeytinburnu: ["bakirkoy", "fatih", "esenler"],
    fatih: ["beyoglu", "zeytinburnu", "esenler", "bakirkoy"],
    beyoglu: ["sisli", "besiktas", "fatih", "kagithane"],
    sisli: ["besiktas", "beyoglu", "kagithane", "sariyer"],
    besiktas: ["sisli", "sariyer", "beyoglu", "kagithane"],
    sariyer: ["besiktas", "kagithane", "sisli", "eyupsultan"],
    kagithane: ["sisli", "besiktas", "sariyer", "eyupsultan"],
    eyupsultan: ["kagithane", "sariyer", "fatih", "esenler"],
    esenler: ["zeytinburnu", "fatih", "basaksehir", "bahcelievler"],
    basaksehir: ["esenler", "bahcelievler", "beylikduzu"],
    beylikduzu: ["basaksehir", "bahcelievler", "bakirkoy"],
    nisantasi: ["sisli", "besiktas", "beyoglu"],
    etiler: ["besiktas", "sisli", "sariyer"],
    levent: ["besiktas", "sisli", "sariyer"],
    mecidiyekoy: ["sisli", "besiktas", "kagithane"],
    florya: ["bakirkoy", "bahcelievler", "beylikduzu"],
    yesilkoy: ["bakirkoy", "bahcelievler"],
    yesilyurt: ["bakirkoy", "bahcelievler"],
    atakoy: ["bakirkoy", "bahcelievler", "zeytinburnu"],
    senlikkoy: ["bakirkoy", "bahcelievler"],
    // İstanbul — Anadolu
    kadikoy: ["uskudar", "atasehir", "maltepe"],
    uskudar: ["kadikoy", "umraniye", "atasehir"],
    atasehir: ["kadikoy", "uskudar", "umraniye", "maltepe"],
    maltepe: ["kadikoy", "atasehir", "kartal"],
    kartal: ["maltepe", "pendik", "atasehir"],
    pendik: ["kartal", "tuzla", "maltepe"],
    tuzla: ["pendik", "kartal"],
    umraniye: ["uskudar", "atasehir", "cekmekoy"],
    cekmekoy: ["umraniye", "uskudar", "atasehir"],
    goztepe: ["kadikoy", "atasehir", "maltepe"],
    "bagdat caddesi": ["kadikoy", "maltepe", "atasehir"],
    kozyatagi: ["kadikoy", "atasehir", "maltepe"],
    suadiye: ["kadikoy", "maltepe", "atasehir"],
    caddebostan: ["kadikoy", "maltepe", "atasehir"],
    moda: ["kadikoy", "uskudar", "atasehir"],
    bostanci: ["kadikoy", "maltepe", "atasehir"],
    fenerbahce: ["kadikoy", "atasehir", "maltepe"],
    // Ankara
    cankaya: ["yenimahalle", "kecioren", "mamak", "altindag", "etimesgut"],
    yenimahalle: ["cankaya", "kecioren", "etimesgut", "sincan"],
    kecioren: ["yenimahalle", "altindag", "cankaya"],
    mamak: ["cankaya", "altindag", "kecioren"],
    etimesgut: ["yenimahalle", "sincan", "cankaya"],
    sincan: ["etimesgut", "yenimahalle"],
    altindag: ["kecioren", "mamak", "cankaya"],
    kizilay: ["cankaya", "altindag", "yenimahalle"],
    tunali: ["cankaya", "kizilay"],
    cayyolu: ["cankaya", "yenimahalle", "etimesgut"],
    umitkoy: ["cankaya", "yenimahalle", "etimesgut"],
    // İzmir
    konak: ["karsiyaka", "bornova", "buca", "bayrakli", "gaziemir"],
    karsiyaka: ["konak", "bayrakli", "cigli", "bornova"],
    bornova: ["konak", "bayrakli", "buca", "karsiyaka"],
    buca: ["konak", "bornova", "gaziemir"],
    cigli: ["karsiyaka", "bayrakli"],
    bayrakli: ["karsiyaka", "bornova", "konak"],
    gaziemir: ["buca", "konak", "guzelbahce"],
    alsancak: ["konak", "bayrakli", "karsiyaka"],
    guzelbahce: ["konak", "gaziemir"],
    // İstanbul dış çeper
    silivri: ["beylikduzu", "basaksehir", "bahcelievler"],
    // Antalya
    konyaalti: ["muratpasa", "kepez", "lara"],
    muratpasa: ["konyaalti", "lara", "kepez"],
    lara: ["muratpasa", "konyaalti"],
    kepez: ["muratpasa", "konyaalti"],
    // Kocaeli — Gebze/Darıca İstanbul Anadolu çeperine bitişik, Tuzla/Pendik
    // gerçekçi alternatiftir (şehirler arası ama coğrafi olarak yakın).
    gebze: ["darica", "tuzla", "pendik", "izmit"],
    darica: ["gebze", "tuzla", "pendik"],
    izmit: ["gebze", "darica"],
};
/** Normalized district key → user-facing Turkish display name. */
const DISTRICT_DISPLAY = {
    kadikoy: "Kadıköy", goztepe: "Göztepe", "bagdat caddesi": "Bağdat Caddesi",
    kozyatagi: "Kozyatağı", suadiye: "Suadiye", caddebostan: "Caddebostan",
    moda: "Moda", bostanci: "Bostancı", uskudar: "Üsküdar",
    atasehir: "Ataşehir", maltepe: "Maltepe", kartal: "Kartal",
    pendik: "Pendik", tuzla: "Tuzla", cekmekoy: "Çekmeköy",
    umraniye: "Ümraniye", fenerbahce: "Fenerbahçe",
    besiktas: "Beşiktaş", sisli: "Şişli", beyoglu: "Beyoğlu",
    sariyer: "Sarıyer", bakirkoy: "Bakırköy", bahcelievler: "Bahçelievler",
    beylikduzu: "Beylikdüzü", fatih: "Fatih", zeytinburnu: "Zeytinburnu",
    basaksehir: "Başakşehir", esenler: "Esenler", kagithane: "Kağıthane",
    eyupsultan: "Eyüpsultan", nisantasi: "Nişantaşı", etiler: "Etiler",
    levent: "Levent", mecidiyekoy: "Mecidiyeköy",
    florya: "Florya", yesilkoy: "Yeşilköy", yesilyurt: "Yeşilyurt",
    atakoy: "Ataköy", senlikkoy: "Şenlikköy",
    cankaya: "Çankaya", yenimahalle: "Yenimahalle", kecioren: "Keçiören",
    mamak: "Mamak", etimesgut: "Etimesgut", sincan: "Sincan",
    altindag: "Altındağ", kizilay: "Kızılay", tunali: "Tunalı",
    cayyolu: "Çayyolu", umitkoy: "Ümitköy",
    konak: "Konak", karsiyaka: "Karşıyaka", bornova: "Bornova",
    buca: "Buca", cigli: "Çiğli", bayrakli: "Bayraklı",
    gaziemir: "Gaziemir", alsancak: "Alsancak", guzelbahce: "Güzelbahçe",
    silivri: "Silivri",
    konyaalti: "Konyaaltı", muratpasa: "Muratpaşa", lara: "Lara", kepez: "Kepez",
    gebze: "Gebze", darica: "Darıca", izmit: "İzmit",
};
/** User-facing Turkish name for a normalized district key. */
export function districtDisplayName(district) {
    const key = normTR(district);
    return DISTRICT_DISPLAY[key] ?? district;
}
/**
 * Data-driven "yakın ilçe" suggestions: for each same-side neighbour of the
 * requested district, count how many of the given therapists actually have a
 * physical branch there. Only neighbours with at least one therapist are
 * returned, so the model can never advertise an empty district — and never
 * an opposite-side one, because the adjacency map is same-side only.
 */
export function suggestNearbyDistricts(therapists, district) {
    const key = normTR(district);
    const neighbours = NEARBY_DISTRICTS[key] ?? [];
    const out = [];
    for (const n of neighbours) {
        const count = therapists.filter((t) => therapistInDistrict(t, n)).length;
        if (count > 0) {
            out.push({
                district: n,
                display_name: districtDisplayName(n),
                therapist_count: count,
            });
        }
    }
    return out;
}
export function therapistInDistrict(t, district) {
    const target = normTR(district);
    if (!target)
        return false;
    const keywords = [target, ...(DISTRICT_SUBAREAS[target] ?? [])];
    return (t.branches ?? []).some((b) => {
        if (!b || b.type !== "physical")
            return false;
        const name = normTR(b.name ?? "");
        const addr = normTR(b.address ?? "");
        return keywords.some((k) => name.includes(k) || addr.includes(k));
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