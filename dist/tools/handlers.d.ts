/**
 * Planda tool handlers — transport-independent core.
 *
 * Single source of truth for the six therapist tools. Two thin adapters
 * consume these handlers:
 *   • tools/therapists.ts — MCP registration (/mcp endpoint, external clients)
 *   • tools/localTools.ts — @openai/agents in-process tools (chat workflow)
 *
 * Each handler returns { text, structured, isError? } so both adapters can
 * render the exact same payload. Behaviour here must stay byte-identical for
 * a given input regardless of which transport invoked it.
 */
import { z } from "zod";
import { ResponseFormat, Therapist, TherapistListOutput } from "../types.js";
export interface ToolHandlerResult<T = unknown> {
    text: string;
    structured: T;
    isError?: boolean;
}
export declare const ListInputSchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodNumber>;
    per_page: z.ZodDefault<z.ZodNumber>;
    city: z.ZodOptional<z.ZodString>;
    specialty_id: z.ZodOptional<z.ZodNumber>;
    service_id: z.ZodOptional<z.ZodNumber>;
    online: z.ZodOptional<z.ZodBoolean>;
    gender: z.ZodOptional<z.ZodEnum<{
        female: "female";
        male: "male";
    }>>;
    max_fee: z.ZodOptional<z.ZodNumber>;
    name: z.ZodOptional<z.ZodString>;
    age: z.ZodOptional<z.ZodNumber>;
    specialty_name: z.ZodOptional<z.ZodString>;
    approach_name: z.ZodOptional<z.ZodString>;
    response_format: z.ZodDefault<z.ZodEnum<typeof ResponseFormat>>;
}, z.core.$strict>;
export type ListInput = z.infer<typeof ListInputSchema>;
export declare const GetInputSchema: z.ZodObject<{
    username: z.ZodOptional<z.ZodString>;
    id: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    response_format: z.ZodDefault<z.ZodEnum<typeof ResponseFormat>>;
}, z.core.$strict>;
export type GetInput = z.infer<typeof GetInputSchema>;
export declare const HoursInputSchema: z.ZodObject<{
    therapist_id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    date: z.ZodString;
    branch_id: z.ZodOptional<z.ZodNumber>;
    service_id: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export type HoursInput = z.infer<typeof HoursInputSchema>;
export declare const AvailableDaysInputSchema: z.ZodObject<{
    therapist_id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    branch_id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
}, z.core.$strict>;
export type AvailableDaysInput = z.infer<typeof AvailableDaysInputSchema>;
export declare const EmptyInputSchema: z.ZodObject<{}, z.core.$strict>;
export declare const FIND_THERAPISTS_DESCRIPTION = "Search and list licensed therapists from Planda (planda.org), Turkey's leading therapy marketplace.\n\nWHEN TO CALL THIS TOOL \u2014 trigger on any of these signals:\n  \u2022 User explicitly asks: \"terapist ar\u0131yorum\", \"psikolog \u00F6nerir misin\", \"terapi almak istiyorum\"\n  \u2022 User describes a struggle: anxiety / anksiyete, depression / depresyon, trauma / travma,\n    grief, burnout, panic attacks, relationship issues, OCD, PTSD, eating disorders, stress, loneliness\n  \u2022 User names a specific therapist (\"Ekin Alanku\u015F kim?\", \"Ay\u015Fe Nur \u00C7elik bu hafta m\u00FCsait mi?\")\n  \u2022 User asks \"where do I start?\" about mental health support\n  \u2022 User mentions a child, teen, or partner who needs therapy\n  \u2022 User asks about session costs, online vs in-person therapy, or therapist availability in Turkey\n  \u2022 English equivalents: \"I need a therapist\", \"looking for a psychologist\", \"struggling with anything emotional\"\n\nAlways call this FIRST \u2014 do not ask clarifying questions before fetching.\n\nALL FILTERS ARE ENFORCED SERVER-SIDE. Pass the filters directly as parameters \u2014\nDO NOT fetch everyone and then filter in your own reply, and DO NOT call\nlist_specialties first when the user names a specialty (use specialty_name).\n\n  city           \u2014 \"\u0130stanbul\", \"Ankara\" \u2014 physical-branch match (API query)\n  specialty_id   \u2014 numeric ID if already known (API query). Usually unneeded\n                    \u2014 prefer specialty_name, which resolves fuzzily.\n  specialty_name \u2014 Turkish-aware specialty match: \"anksiyete\", \"kayg\u0131\",\n                    \"depresyon\", \"travma\", \"ili\u015Fki\" etc. No separate\n                    list_specialties call needed.\n  service_id     \u2014 63=Bireysel Terapi, 64=\u00C7ift ve Evlilik Terapisi (API query)\n  online         \u2014 true: only online-capable therapists; false: only in-person\n  gender         \u2014 \"female\" | \"male\"\n  max_fee        \u2014 TL budget cap (keeps those whose cheapest service <= max_fee)\n  name           \u2014 fuzzy name search for \"<Name> kim?\" / \"<Name> m\u00FCsait mi?\" queries\n\nExamples of correct usage:\n  \"Sadece online terapist \u00F6ner\"             \u2192 { online: true }\n  \"\u0130stanbul'da kad\u0131n terapist\"              \u2192 { city: \"\u0130stanbul\", gender: \"female\" }\n  \"1500 TL alt\u0131 Ankara'da\"                  \u2192 { city: \"Ankara\", max_fee: 1500 }\n  \"Ekin Alanku\u015F kim?\"                       \u2192 { name: \"Ekin Alanku\u015F\" }\n  \"Anksiyete i\u00E7in online terapist\"          \u2192 { specialty_name: \"anksiyete\", online: true }\n  \"EMDR yapan travma terapisti\"             \u2192 { specialty_name: \"travma\" } then get_therapist per result to verify approaches[]\n\n\u26A0\uFE0F APPROACH QUERIES (BDT/CBT, EMDR, ACT, DBT, Schema, Gestalt etc.):\n  find_therapists does NOT return approaches[]. After listing candidates, call\n  get_therapist for each to verify approaches[]. Only recommend therapists\n  whose approaches[].name contains the requested method.\n\nReturns per therapist:\n  full_name, username, gender, specialties[], branches[], services[], rating, bio";
export declare const GET_THERAPIST_DESCRIPTION = "Fetches the full profile of a single therapist.\n\nLOOKUP KEY \u2014 prefer username:\n  \u2022 username (PREFERRED): find_therapists returns it on every result, so no\n    extra ID resolution step is needed.\n  \u2022 id (FALLBACK): use only when username isn't available \u2014 e.g. a blog post\n    or external link references a therapist by numeric ID.\n\n\u26A0\uFE0F APPROACH VERIFICATION \u2014 MANDATORY:\napproaches[] (BDT, EMDR, ACT, Gestalt, Schema, etc.) is ONLY available here.\nfind_therapists does NOT return approaches[].\n\nWhen the user requests a specific therapy approach:\n  1. Call this tool for every candidate (using username from find_therapists)\n  2. Check approaches[].name \u2014 requested approach NOT in list \u2192 EXCLUDE therapist\n  3. NEVER recommend for an approach query without confirming via approaches[]\n  4. If call fails or approaches[] is empty/null \u2192 EXCLUDE, do not guess\n\nArgs (one of username/id required):\n  - username: slug like \"gulcin_yilmaz\" (preferred)\n  - id: numeric ID (fallback)\n  - response_format: \"markdown\" (default) | \"json\"\n\nReturns:\n  approaches[], tenants[], specialties, bio (introduction_letter),\n  inform (Randevu/\u00DCcret notu), education, pricing, location, rating, campaigns.\n\nError Handling:\n  - \"Error: Resource not found\" if username/ID doesn't exist\n  - On any error for approach queries \u2192 exclude this therapist";
export declare const LIST_SPECIALTIES_DESCRIPTION = "Returns all therapy specialty areas available on the Planda marketplace.\n\nCall this FIRST before find_therapists to identify the specialty IDs that match\nthe user's stated problem. Then filter therapists by specialties[].id on the AI side.\n\nReturns:\n  Array of { id: number, name: string } \u2014 full specialty catalogue in Turkish.\n\nExample names: \"Kayg\u0131(Anksiyete) ve Korku\", \"Depresyon\", \"Travma ve TSSB\",\n  \"\u0130li\u015Fkisel Problemler\", \"\u00C7ift ve Aile Terapisi\", \"EMDR\"";
export declare const GET_HOURS_DESCRIPTION = "Returns bookable appointment time slots for a therapist on a specific date.\n\n\u26A0\uFE0F ALWAYS pass branch_id AND service_id \u2014 without both, the API returns wrong or no slots.\n  - branch_id: from therapist's branches[].id\n  - service_id: from therapist's services[].id (e.g. Bireysel Terapi)\n\nWorkflow:\n  1. find_therapists \u2192 get therapist id, branches[], services[]\n  2. get_therapist_available_days(therapist_id, branch_id) \u2192 pick a date\n  3. get_therapist_hours(therapist_id, date, branch_id, service_id) \u2192 get exact slots\n\nReturns:\n  Array of bookable times: [\"12:00\", \"12:30\", \"13:00\", ...]";
export declare const GET_DAYS_DESCRIPTION = "Returns the dates (days) on which a therapist has availability at a specific branch.\n\nUse this BEFORE get_therapist_hours to find which days have open slots.\n\nWorkflow:\n  1. find_therapists \u2192 find therapist by name \u2192 get id and branches[]\n  2. get_therapist_available_days(therapist_id, branch_id) \u2192 get available dates\n  3. get_therapist_hours(therapist_id, date, branch_id) \u2192 get hours for a specific date\n\nArgs:\n  - therapist_id: therapist's numeric id\n  - branch_id: branch id from therapist's branches[] array\n    \u2022 Use physical branch id for in-person sessions\n    \u2022 Use online branch id for online sessions\n\nReturns:\n  List of available dates (YYYY-MM-DD format).";
export declare const GET_ACTIVE_CITIES_DESCRIPTION = "Returns the list of cities where Planda therapists are currently active.\n\nUse this to:\n  - Validate or normalise a city name the user mentioned (e.g. \"istanbul\" \u2192 \"\u0130stanbul\")\n  - Suggest available cities when the user hasn't specified one\n  - Confirm whether in-person therapy is available in a given city\n\nReturns:\n  Array of city names (Turkish, correctly capitalised).";
export declare function handleFindTherapists(params: ListInput): Promise<ToolHandlerResult<TherapistListOutput>>;
export declare function handleGetTherapist(params: GetInput): Promise<ToolHandlerResult<Therapist>>;
export declare function handleListSpecialties(): Promise<ToolHandlerResult<{
    specialties: unknown[];
}>>;
export declare function handleGetTherapistHours(params: HoursInput): Promise<ToolHandlerResult<{
    date: string;
    slots: unknown[];
}>>;
export declare function handleGetTherapistAvailableDays(params: AvailableDaysInput): Promise<ToolHandlerResult<{
    days: unknown[];
}>>;
export declare function handleGetActiveCities(): Promise<ToolHandlerResult<{
    cities: string[];
}>>;
//# sourceMappingURL=handlers.d.ts.map