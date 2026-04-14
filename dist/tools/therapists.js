/**
 * Planda MCP Server — Therapist Tools
 *
 * Registers four tools on the provided McpServer instance:
 *   1. planda_list_therapists   — paginated list with optional filters
 *   2. planda_get_therapist     — single therapist detail by ID
 *   3. planda_search_therapists — keyword / criteria search
 *   4. planda_check_availability — lightweight count check for dynamic conversation
 */
import { z } from "zod";
import { makeApiRequest, handleApiError } from "../services/apiClient.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { ResponseFormat, } from "../types.js";
// ─── Shared Zod schemas ───────────────────────────────────────────────────────
const PaginationSchema = z.object({
    page: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Page number (starts at 1)"),
    per_page: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .default(50)
        .describe("Results per page (1–10000, default 50). Use 100 to fetch all therapists in one call (~59 total)."),
});
// Only confirmed-working filter params (tested via /api/debug/params):
// - city: confirmed working
// - online, gender, min_price, max_price, specialties, order_by: ALL ignored by API (return full 59)
const FilterSchema = z.object({
    city: z
        .string()
        .optional()
        .describe('Filter by city name, e.g. "İstanbul", "Ankara". Only confirmed working filter.'),
});
const FormatSchema = z.object({
    response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe('Output format: "markdown" for human-readable, "json" for structured data'),
});
// ─── Helper functions ─────────────────────────────────────────────────────────
/** Strips HTML tags from introduction_letter and other HTML fields */
function stripHtml(html) {
    return html
        .replace(/<\/p>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
/** Normalises the various list-response shapes the API might return */
function normaliseListResponse(raw, page, per_page) {
    const therapists = raw.data ?? raw.therapists ?? raw.results ?? [];
    const total = raw.meta?.total ?? raw.total ?? raw.count ?? therapists.length;
    const lastPage = raw.meta?.last_page ?? Math.ceil(total / per_page);
    const hasMore = page < lastPage;
    return {
        total,
        count: therapists.length,
        page,
        per_page,
        has_more: hasMore,
        next_page: hasMore ? page + 1 : null,
        therapists,
    };
}
/** Strips large text fields from therapist data to keep list response compact */
function stripHeavyFields(therapists) {
    return therapists.map((t) => {
        if (!t.data)
            return t;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { introduction_letter, inform, ...lightData } = t.data;
        return { ...t, data: lightData };
    });
}
/** Renders a single therapist as Markdown using the real API structure */
function therapistToMarkdown(t, index) {
    const prefix = index !== undefined ? `### ${index + 1}. ` : "## ";
    const lines = [];
    const displayName = t.full_name?.trim() ||
        [t.name, t.surname].filter(Boolean).join(" ").trim() ||
        `Terapist #${t.id}`;
    lines.push(`${prefix}${displayName} *(ID: ${t.id})*`);
    // Title from nested data
    const titleName = t.data?.title?.name;
    if (titleName)
        lines.push(`**Unvan:** ${titleName}`);
    // Gender — top-level or data.gender
    const gender = t.gender ?? t.data?.gender;
    if (gender) {
        const genderLabel = gender === "female" ? "Kadın" : gender === "male" ? "Erkek" : gender;
        lines.push(`**Cinsiyet:** ${genderLabel}`);
    }
    // Specialties — now [{id, name}] objects
    const specialties = Array.isArray(t.specialties)
        ? t.specialties.map((s) => (typeof s === "object" && s !== null ? s.name : String(s))).filter(Boolean)
        : [];
    if (specialties.length)
        lines.push(`**Uzmanlık:** ${specialties.join(", ")}`);
    // Education from nested universities + departments
    const edu = [];
    if (t.data?.undergraduateUniversity?.name) {
        const dept = t.data.undergraduateDepartment?.name ? ` — ${t.data.undergraduateDepartment.name}` : "";
        edu.push(`Lisans: ${t.data.undergraduateUniversity.name}${dept}`);
    }
    if (t.data?.postgraduateUniversity?.name) {
        const dept = t.data.postgraduateDepartment?.name ? ` — ${t.data.postgraduateDepartment.name}` : "";
        edu.push(`Y.Lisans: ${t.data.postgraduateUniversity.name}${dept}`);
    }
    if (t.data?.doctorateUniversity?.name) {
        const dept = t.data.doctorateDepartment?.name ? ` — ${t.data.doctorateDepartment.name}` : "";
        edu.push(`Doktora: ${t.data.doctorateUniversity.name}${dept}`);
    }
    if (edu.length)
        lines.push(`**Eğitim:** ${edu.join(" | ")}`);
    // Age range
    const other = t.data?.other;
    if (other && !other.accept_all_ages && (other.min_client_age || other.max_client_age)) {
        lines.push(`**Yaş Aralığı:** ${other.min_client_age ?? "?"} – ${other.max_client_age ?? "?"}`);
    }
    else if (other?.accept_all_ages) {
        lines.push(`**Yaş:** Tüm yaşlar`);
    }
    // Location from branches
    const physicalBranches = (t.branches ?? []).filter((b) => b.type === "physical" && b.city);
    const onlineBranch = (t.branches ?? []).find((b) => b.type === "online");
    if (physicalBranches.length) {
        const cities = [...new Set(physicalBranches.map((b) => b.city?.name).filter(Boolean))];
        lines.push(`**Şehir:** ${cities.join(", ")}`);
        const addresses = physicalBranches.map((b) => `${b.name}${b.address ? " — " + b.address : ""}`);
        lines.push(`**Adres:** ${addresses.join(" | ")}`);
    }
    if (onlineBranch)
        lines.push(`**Online:** Evet`);
    // Clinic / tenant
    if (t.tenants?.length) {
        lines.push(`**Klinik:** ${t.tenants[0].company_name ?? t.tenants[0].name}`);
    }
    // Services / pricing — fees are strings like "6500.00", parse to int
    if (t.services?.length) {
        const serviceLines = t.services.map((s) => {
            const rawFee = s.custom_fee ?? s.fee;
            const fee = rawFee ? Math.round(parseFloat(rawFee)) : null;
            return `${s.name}: ${fee ? fee + " TL" : "belirtilmemiş"}`;
        });
        lines.push(`**Ücret:** ${serviceLines.join(" | ")}`);
    }
    // Rating
    const rating = t.data?.weighted_rating ?? t.data?.rating ?? t.rating;
    if (rating)
        lines.push(`**Puan:** ${Number(rating).toFixed(1)}`);
    // Therapy approaches (only on detail/get calls)
    const approaches = Array.isArray(t.approaches)
        ? t.approaches.map((a) => a.name).filter(Boolean)
        : [];
    if (approaches.length)
        lines.push(`**Terapi Yaklaşımı:** ${approaches.join(", ")}`);
    // Username — expose plainly so agent can use it in [[expert:username]] tags
    if (t.username) {
        lines.push(`**username:** ${t.username}`);
    }
    // Bio — strip HTML, expose full text for keyword search (truncate to 600)
    const rawBio = t.data?.introduction_letter;
    if (rawBio) {
        const cleanBio = stripHtml(rawBio);
        const shortBio = cleanBio.length > 600 ? cleanBio.slice(0, 597) + "..." : cleanBio;
        lines.push(`**Biyografi:** ${shortBio}`);
    }
    lines.push(""); // blank line separator
    return lines.join("\n");
}
/** Truncates the output object if it exceeds CHARACTER_LIMIT */
function applyCharacterLimit(output) {
    const json = JSON.stringify(output);
    if (json.length <= CHARACTER_LIMIT)
        return output;
    // Halve the therapist list until we fit
    let therapists = [...output.therapists];
    while (JSON.stringify({ ...output, therapists }).length > CHARACTER_LIMIT &&
        therapists.length > 1) {
        therapists = therapists.slice(0, Math.ceil(therapists.length / 2));
    }
    return {
        ...output,
        therapists,
        count: therapists.length,
        truncated: true,
        truncation_message: `Response truncated from ${output.count} to ${therapists.length} therapists. Use 'page' or add filters to retrieve more results.`,
    };
}
// ─── Tool registration ────────────────────────────────────────────────────────
export function registerTherapistTools(server) {
    // ── 1. planda_list_therapists ────────────────────────────────────────────────
    const ListInputSchema = PaginationSchema.merge(FilterSchema)
        .merge(FormatSchema)
        .strict();
    server.registerTool("planda_list_therapists", {
        title: "List Planda Therapists",
        description: `Returns a paginated list of therapists from the Planda marketplace.

Workflow:
  1. Call planda_list_specialties to get specialty IDs matching the user's need.
  2. Call this tool with city/online filter to fetch a broad list (~59 total; use per_page:100).
  3. Filter results by specialties[].id or specialties[].name on the AI side.
  4. Call planda_get_therapist for top 3–5 candidates to get approaches[] and tenants[].

Confirmed working filter params (all others are silently ignored by the API):
  - city (string): e.g. "İstanbul", "Ankara"
  - page / per_page: pagination (use per_page:100 to fetch all ~59 in one call)

NOT WORKING (tested, return full 59 results regardless):
  online, gender, min_price, max_price, specialties, order_by
  → Filter these on the AI side after fetching.
  → For online: check branches[].type === "online"
  → For city: check branches[].city.name
  → For price: check services[].custom_fee or services[].fee
  → For specialty: use IDs from planda_list_specialties, match specialties[].id

Returns:
  List with name, specialties, location, pricing, and bio.`,
        inputSchema: ListInputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (params) => {
        try {
            // Build query params — omit undefined values
            const query = {
                page: params.page,
                per_page: params.per_page,
            };
            if (params.city)
                query["city"] = params.city;
            const raw = await makeApiRequest("marketplace/therapists", "GET", undefined, query);
            let output = normaliseListResponse(raw, params.page, params.per_page);
            // Strip large bio fields before character limit check — prevents truncation of list
            output = { ...output, therapists: stripHeavyFields(output.therapists) };
            output = applyCharacterLimit(output);
            if (!output.therapists.length) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Belirtilen kriterlere uygun terapist bulunamadı.",
                        },
                    ],
                };
            }
            let text;
            if (params.response_format === ResponseFormat.JSON) {
                text = JSON.stringify(output, null, 2);
            }
            else {
                const lines = [
                    `# Planda Terapist Listesi`,
                    "",
                    `**Toplam:** ${output.total} terapist | **Sayfa:** ${output.page} | **Gösterilen:** ${output.count}`,
                    output.truncated ? `\n⚠️ ${output.truncation_message}` : "",
                    "",
                ];
                output.therapists.forEach((t, i) => {
                    lines.push(therapistToMarkdown(t, i));
                });
                if (output.has_more) {
                    lines.push(`---\n*Daha fazla sonuç için \`page: ${output.next_page}\` parametresini kullanın.*`);
                }
                text = lines.filter((l) => l !== undefined).join("\n");
            }
            return {
                content: [{ type: "text", text }],
                structuredContent: output,
            };
        }
        catch (error) {
            return { content: [{ type: "text", text: handleApiError(error) }] };
        }
    });
    // ── 2. planda_get_therapist ──────────────────────────────────────────────────
    const GetInputSchema = z
        .object({
        id: z
            .union([z.string(), z.number()])
            .describe("The therapist's unique ID (string or number)"),
        response_format: z
            .nativeEnum(ResponseFormat)
            .default(ResponseFormat.MARKDOWN)
            .describe('Output format: "markdown" for human-readable, "json" for structured data'),
    })
        .strict();
    server.registerTool("planda_get_therapist", {
        title: "Get Planda Therapist Detail",
        description: `Fetches the full profile of a single therapist from the Planda marketplace by their unique ID.

Args:
  - id (string | number): The therapist's unique identifier
  - response_format ("markdown" | "json"): Output format (default: "markdown")

Returns:
  Complete therapist profile including name, specialties, location, pricing, rating, bio, education, and age range.

Examples:
  - "Show me details for therapist 42" → id=42
  - "Get the profile of therapist abc-123" → id="abc-123"

Error Handling:
  - Returns "Error: Resource not found" if the ID doesn't exist`,
        inputSchema: GetInputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async (params) => {
        try {
            const raw = await makeApiRequest(`marketplace/therapists/${params.id}`);
            // Handle both { data: Therapist } and bare Therapist responses
            const therapist = "data" in raw && raw.data ? raw.data : raw;
            let text;
            if (params.response_format === ResponseFormat.JSON) {
                text = JSON.stringify(therapist, null, 2);
            }
            else {
                text = `# Terapist Profili\n\n${therapistToMarkdown(therapist)}`;
            }
            return {
                content: [{ type: "text", text }],
                structuredContent: therapist,
            };
        }
        catch (error) {
            return { content: [{ type: "text", text: handleApiError(error) }] };
        }
    });
    // ── 3. planda_list_specialties ──────────────────────────────────────────────
    server.registerTool("planda_list_specialties", {
        title: "List Planda Specialties",
        description: `Returns all therapy specialty areas available on the Planda marketplace.

Call this FIRST before planda_list_therapists to identify the specialty IDs that match
the user's stated problem. Then filter therapists by specialties[].id on the AI side.

Returns:
  Array of { id: number, name: string } — full specialty catalogue in Turkish.

Example names: "Kaygı(Anksiyete) ve Korku", "Depresyon", "Travma ve TSSB",
  "İlişkisel Problemler", "Çift ve Aile Terapisi", "EMDR"`,
        inputSchema: z.object({}).strict(),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async () => {
        try {
            const raw = await makeApiRequest("marketplace/specialties");
            // API may return array directly or wrapped in { data: [...] }
            const specialties = Array.isArray(raw)
                ? raw
                : Array.isArray(raw.data)
                    ? raw.data
                    : [];
            const text = specialties.length
                ? specialties
                    .map((s) => {
                    const sp = s;
                    return `- ID ${sp.id}: ${sp.name}`;
                })
                    .join("\n")
                : "Uzmanlık alanı listesi alınamadı.";
            return {
                content: [{ type: "text", text: `# Planda Uzmanlık Alanları\n\n${text}` }],
                structuredContent: { specialties },
            };
        }
        catch (error) {
            return { content: [{ type: "text", text: handleApiError(error) }] };
        }
    });
    // ── 4. planda_get_therapist_hours ────────────────────────────────────────────
    const HoursInputSchema = z
        .object({
        therapist_id: z
            .union([z.string(), z.number()])
            .describe("The therapist's unique ID (from planda_list_therapists or planda_get_therapist)"),
        date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe("Date to check availability for, in YYYY-MM-DD format (e.g. 2025-05-20)"),
        branch_id: z
            .number()
            .int()
            .optional()
            .describe("Branch ID to filter by location (from branches[].id in therapist data)"),
        service_id: z
            .number()
            .int()
            .optional()
            .describe("Service ID to filter by session type (from services[].id in therapist data)"),
    })
        .strict();
    server.registerTool("planda_get_therapist_hours", {
        title: "Get Therapist Available Hours",
        description: `Returns available appointment slots for a specific therapist on a given date.

Workflow:
  1. Call planda_list_therapists to find the therapist by name → get their id.
  2. Optionally get branch_id from branches[] and service_id from services[].
  3. Call this tool with therapist_id, date, and optional branch_id / service_id.

Args:
  - therapist_id: therapist's numeric id
  - date: YYYY-MM-DD (e.g. "2025-05-20")
  - branch_id (optional): filter by branch/location
  - service_id (optional): filter by service type

Returns:
  List of available time slots for that day.`,
        inputSchema: HoursInputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (params) => {
        try {
            const query = { date: params.date };
            if (params.branch_id !== undefined)
                query["branch_id"] = params.branch_id;
            if (params.service_id !== undefined)
                query["service_id"] = params.service_id;
            const raw = await makeApiRequest(`marketplace/therapists/${params.therapist_id}/hours`, "GET", undefined, query);
            // Normalise — API may return array or { data: [...] } or { hours: [...] }
            const slots = Array.isArray(raw)
                ? raw
                : Array.isArray(raw.data)
                    ? raw.data
                    : Array.isArray(raw.hours)
                        ? raw.hours
                        : [];
            if (!slots.length) {
                return {
                    content: [{ type: "text", text: `${params.date} tarihinde müsait saat bulunamadı.` }],
                    structuredContent: { date: params.date, slots: [] },
                };
            }
            const lines = [`# Müsait Saatler — ${params.date}`, ""];
            slots.forEach((slot) => {
                const s = slot;
                // Handle common slot shapes: { time }, { start_time }, { start }, { slot }
                const time = (s["time"] ?? s["start_time"] ?? s["start"] ?? s["slot"] ?? JSON.stringify(s));
                lines.push(`- ${time}`);
            });
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                structuredContent: { date: params.date, slots },
            };
        }
        catch (error) {
            return { content: [{ type: "text", text: handleApiError(error) }] };
        }
    });
}
//# sourceMappingURL=therapists.js.map