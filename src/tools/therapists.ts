/**
 * Planda MCP Server — Therapist Tools
 *
 * Registers five tools on the provided McpServer instance:
 *   1. find_therapists               — paginated list with optional filters
 *   2. get_therapist                 — single therapist detail by ID
 *   3. list_specialties              — all specialty areas
 *   4. get_therapist_hours           — available time slots for a date
 *   5. get_therapist_available_days  — available dates for a branch
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleApiError } from "../services/apiClient.js";
import {
  findTherapists,
  getTherapist,
  listSpecialties as apiListSpecialties,
  getTherapistHours as apiGetTherapistHours,
  getTherapistAvailableDays as apiGetTherapistAvailableDays,
  getActiveCities as apiGetActiveCities,
} from "../services/therapistApi.js";
import { CHARACTER_LIMIT } from "../constants.js";
import {
  ResponseFormat,
  Therapist,
  TherapistListResponse,
  TherapistListOutput,
} from "../types.js";
import { applyAiSideFilters } from "../services/therapistFilters.js";
import {
  resolveLocation,
  therapistInDistrict,
  istanbulSide,
  matchesIstanbulSide,
} from "../services/locationNormalizer.js";

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

// All filters below are enforced server-side inside the tool handler —
// either via the Planda API query parameters (city/specialty_id/service_id)
// or via JS post-filter (online/gender/max_fee/name). The AI should ALWAYS
// pass filters here instead of fetching-then-filtering in its own response.
const FilterSchema = z.object({
  city: z
    .string()
    .optional()
    .describe('City name for physical-branch match, e.g. "İstanbul", "Ankara". Applied via API query.'),
  specialty_id: z
    .number()
    .int()
    .optional()
    .describe("Specialty ID from list_specialties (e.g. 26=Kaygı, 18=Depresyon, 35=Travma). Applied via API query."),
  service_id: z
    .number()
    .int()
    .optional()
    .describe("Service ID: 63=Bireysel Terapi, 64=Çift ve Evlilik Terapisi. Applied via API query."),
  online: z
    .boolean()
    .optional()
    .describe('true → only therapists with an online branch. false → only in-person. Omit for both. Post-filtered server-side (branches[].type).'),
  gender: z
    .enum(["female", "male"])
    .optional()
    .describe('Filter by therapist gender. Post-filtered server-side (gender field).'),
  max_fee: z
    .number()
    .positive()
    .optional()
    .describe("Max session fee in TL. Keeps therapists whose cheapest service is <= max_fee. Post-filtered server-side."),
  name: z
    .string()
    .optional()
    .describe('Fuzzy name match (Turkish-aware, lowercased, diacritic-insensitive). Use for "X kim?" / "X bu hafta müsait mi?" lookups. Matches full_name, name+surname, and username.'),
  specialty_name: z
    .string()
    .optional()
    .describe('Turkish-aware fuzzy match against therapist.specialties[].name. PREFER THIS over calling list_specialties first — the specialty data is inline in every therapist record. Examples: "anksiyete" matches "Kaygı(Anksiyete) ve Korku", "travma" matches "Travmatik Deneyim", "depresyon" matches "Depresyon". Post-filtered server-side.'),
});

const FormatSchema = z.object({
  response_format: z
    .nativeEnum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe(
      'Output format: "markdown" for human-readable, "json" for structured data'
    ),
});

// ─── Helper functions ─────────────────────────────────────────────────────────

/** Strips HTML tags from introduction_letter and other HTML fields */
function stripHtml(html: string): string {
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
function normaliseListResponse(
  raw: TherapistListResponse,
  page: number,
  per_page: number
): TherapistListOutput {
  const therapists: Therapist[] =
    raw.data ?? raw.therapists ?? raw.results ?? [];
  const total: number =
    raw.meta?.total ?? raw.total ?? raw.count ?? therapists.length;
  const lastPage: number =
    raw.meta?.last_page ?? Math.ceil(total / per_page);
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
function stripHeavyFields(therapists: Therapist[]): Therapist[] {
  return therapists.map((t) => {
    if (!t.data) return t;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { introduction_letter, inform, ...lightData } = t.data as Record<string, unknown>;
    return { ...t, data: lightData as typeof t.data };
  });
}

/** Renders a single therapist as Markdown using the real API structure */
function therapistToMarkdown(t: Therapist, index?: number): string {
  const prefix = index !== undefined ? `### ${index + 1}. ` : "## ";
  const lines: string[] = [];

  const displayName =
    t.full_name?.trim() ||
    [t.name, t.surname].filter(Boolean).join(" ").trim() ||
    `Terapist #${t.id}`;
  lines.push(`${prefix}${displayName} *(ID: ${t.id})*`);

  // Title from nested data
  const titleName = t.data?.title?.name;
  if (titleName) lines.push(`**Unvan:** ${titleName}`);

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
  if (specialties.length) lines.push(`**Uzmanlık:** ${specialties.join(", ")}`);

  // Education from nested universities + departments
  const edu: string[] = [];
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
  if (edu.length) lines.push(`**Eğitim:** ${edu.join(" | ")}`);

  // Age range
  const other = t.data?.other;
  if (other && !other.accept_all_ages && (other.min_client_age || other.max_client_age)) {
    lines.push(`**Yaş Aralığı:** ${other.min_client_age ?? "?"} – ${other.max_client_age ?? "?"}`);
  } else if (other?.accept_all_ages) {
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
  if (onlineBranch) lines.push(`**Online:** Evet`);

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
  if (rating) lines.push(`**Puan:** ${Number(rating).toFixed(1)}`);

  // Therapy approaches (only on detail/get calls)
  const approaches = Array.isArray(t.approaches)
    ? t.approaches.map((a) => a.name).filter(Boolean)
    : [];
  if (approaches.length) lines.push(`**Terapi Yaklaşımı:** ${approaches.join(", ")}`);

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
function applyCharacterLimit(output: TherapistListOutput): TherapistListOutput {
  const json = JSON.stringify(output);
  if (json.length <= CHARACTER_LIMIT) return output;

  // Halve the therapist list until we fit
  let therapists = [...output.therapists];
  while (
    JSON.stringify({ ...output, therapists }).length > CHARACTER_LIMIT &&
    therapists.length > 1
  ) {
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

// ─── Specialty cache ──────────────────────────────────────────────────────────

const SPECIALTY_CACHE_TTL_MS = 10 * 60 * 1000;
let specialtyCache: { specialties: unknown[]; fetchedAt: number } | null = null;

async function getCachedSpecialties(): Promise<unknown[]> {
  if (specialtyCache && Date.now() - specialtyCache.fetchedAt < SPECIALTY_CACHE_TTL_MS) {
    return specialtyCache.specialties;
  }
  const raw = await apiListSpecialties();
  const specialties: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { data?: unknown[] }).data)
    ? (raw as { data: unknown[] }).data
    : [];
  specialtyCache = { specialties, fetchedAt: Date.now() };
  return specialties;
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerTherapistTools(server: McpServer): void {
  // ── 1. find_therapists ───────────────────────────────────────────────────────
  const ListInputSchema = PaginationSchema.merge(FilterSchema)
    .merge(FormatSchema)
    .strict();

  type ListInput = z.infer<typeof ListInputSchema>;

  server.registerTool(
    "find_therapists",
    {
      title: "Find Planda Therapists",
      description: `Search and list licensed therapists from Planda (planda.org), Turkey's leading therapy marketplace.

WHEN TO CALL THIS TOOL — trigger on any of these signals:
  • User explicitly asks: "terapist arıyorum", "psikolog önerir misin", "terapi almak istiyorum"
  • User describes a struggle: anxiety / anksiyete, depression / depresyon, trauma / travma,
    grief, burnout, panic attacks, relationship issues, OCD, PTSD, eating disorders, stress, loneliness
  • User names a specific therapist ("Ekin Alankuş kim?", "Ayşe Nur Çelik bu hafta müsait mi?")
  • User asks "where do I start?" about mental health support
  • User mentions a child, teen, or partner who needs therapy
  • User asks about session costs, online vs in-person therapy, or therapist availability in Turkey
  • English equivalents: "I need a therapist", "looking for a psychologist", "struggling with anything emotional"

Always call this FIRST — do not ask clarifying questions before fetching.

ALL FILTERS ARE ENFORCED SERVER-SIDE. Pass the filters directly as parameters —
DO NOT fetch everyone and then filter in your own reply, and DO NOT call
list_specialties first when the user names a specialty (use specialty_name).

  city           — "İstanbul", "Ankara" — physical-branch match (API query)
  specialty_id   — numeric ID if already known (API query). Usually unneeded
                    — prefer specialty_name, which resolves fuzzily.
  specialty_name — Turkish-aware specialty match: "anksiyete", "kaygı",
                    "depresyon", "travma", "ilişki" etc. No separate
                    list_specialties call needed.
  service_id     — 63=Bireysel Terapi, 64=Çift ve Evlilik Terapisi (API query)
  online         — true: only online-capable therapists; false: only in-person
  gender         — "female" | "male"
  max_fee        — TL budget cap (keeps those whose cheapest service <= max_fee)
  name           — fuzzy name search for "<Name> kim?" / "<Name> müsait mi?" queries

Examples of correct usage:
  "Sadece online terapist öner"             → { online: true }
  "İstanbul'da kadın terapist"              → { city: "İstanbul", gender: "female" }
  "1500 TL altı Ankara'da"                  → { city: "Ankara", max_fee: 1500 }
  "Ekin Alankuş kim?"                       → { name: "Ekin Alankuş" }
  "Anksiyete için online terapist"          → { specialty_name: "anksiyete", online: true }
  "EMDR yapan travma terapisti"             → { specialty_name: "travma" } then get_therapist per result to verify approaches[]

⚠️ APPROACH QUERIES (BDT/CBT, EMDR, ACT, DBT, Schema, Gestalt etc.):
  find_therapists does NOT return approaches[]. After listing candidates, call
  get_therapist for each to verify approaches[]. Only recommend therapists
  whose approaches[].name contains the requested method.

Returns per therapist:
  full_name, username, gender, specialties[], branches[], services[], rating, bio`,
      inputSchema: ListInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListInput) => {
      try {
        // Resolve district / semt input → parent city + district filter.
        // Turns passing "Göztepe" or "Kartal" into a valid {city:"İstanbul"}
        // API query plus a post-filter keyword, regardless of whether the
        // model remembered the prompt's İLÇE KURALI.
        const resolvedLocation = params.city
          ? resolveLocation(params.city)
          : null;
        const apiCity = resolvedLocation?.city ?? params.city;
        const districtFilter = resolvedLocation?.district ?? null;
        const requestedSide = districtFilter
          ? istanbulSide(districtFilter)
          : null;

        // When post-filters (online/gender/max_fee/name) are requested, we
        // must fetch a wider slice from the API and narrow in JS afterwards.
        // Bump per_page to capture the full roster (~59 therapists).
        const hasPostFilter =
          params.online !== undefined ||
          params.gender !== undefined ||
          params.max_fee !== undefined ||
          params.name !== undefined ||
          params.specialty_name !== undefined ||
          districtFilter !== null;
        const effectivePerPage = hasPostFilter ? Math.max(params.per_page, 200) : params.per_page;

        const raw = await findTherapists({
          page: params.page,
          per_page: effectivePerPage,
          city: apiCity,
          specialty_id: params.specialty_id,
          service_id: params.service_id,
        });

        let output = normaliseListResponse(raw, params.page, effectivePerPage);

        // Server-side filters — authoritative, executed before any truncation
        // or stripping so the model never sees results that violate its ask.
        if (hasPostFilter) {
          let filtered = applyAiSideFilters(output.therapists, {
            online: params.online,
            gender: params.gender,
            max_fee: params.max_fee,
            name: params.name,
            specialty_name: params.specialty_name,
            city: apiCity,
          });

          // District filter — only keep therapists whose branches[] touch
          // the requested district. Note: when user requested yüz yüze
          // (online === false), we require the district match. When user
          // allowed online or unspecified, we keep online-only therapists
          // too so we can offer them as a fallback.
          if (districtFilter) {
            if (params.online === false) {
              filtered = filtered.filter((t) =>
                therapistInDistrict(t, districtFilter)
              );
            } else {
              filtered = filtered.filter(
                (t) =>
                  therapistInDistrict(t, districtFilter) ||
                  (t.branches ?? []).some((b) => b?.type === "online")
              );
            }
          }

          // İstanbul side enforcement — if user's district is on one side,
          // exclude therapists whose ONLY physical branch is on the other
          // side (online-only is still fine as a fallback).
          if (requestedSide) {
            filtered = filtered.filter((t) => {
              const hasOnline = (t.branches ?? []).some((b) => b?.type === "online");
              const matchesSide = matchesIstanbulSide(t, requestedSide);
              return matchesSide || hasOnline;
            });
          }

          output = { ...output, therapists: filtered, count: filtered.length };
        }

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

        let text: string;
        if (params.response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
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
            lines.push(
              `---\n*Daha fazla sonuç için \`page: ${output.next_page}\` parametresini kullanın.*`
            );
          }
          text = lines.filter((l) => l !== undefined).join("\n");
        }

        return {
          content: [{ type: "text", text }],
          structuredContent: output,
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // ── 2. get_therapist ─────────────────────────────────────────────────────────
  const GetInputSchema = z
    .object({
      id: z
        .union([z.string(), z.number()])
        .describe("The therapist's unique ID (string or number)"),
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe(
          'Output format: "markdown" for human-readable, "json" for structured data'
        ),
    })
    .strict();

  type GetInput = z.infer<typeof GetInputSchema>;

  server.registerTool(
    "get_therapist",
    {
      title: "Get Therapist Detail",
      description: `Fetches the full profile of a single therapist by ID.

⚠️ APPROACH VERIFICATION — MANDATORY:
approaches[] (BDT, EMDR, ACT, Gestalt, Schema, etc.) is ONLY available here.
find_therapists does NOT return approaches[].

When the user requests a specific therapy approach:
  1. Call this tool for every candidate
  2. Check approaches[].name — requested approach NOT in list → EXCLUDE therapist
  3. NEVER recommend for an approach query without confirming via approaches[]
  4. If call fails or approaches[] is empty/null → EXCLUDE, do not guess

Args:
  - id: therapist's unique ID (from find_therapists)
  - response_format: "markdown" (default) | "json"

Returns:
  approaches[], tenants[], specialties, bio, education, pricing, location, rating.

Error Handling:
  - "Error: Resource not found" if ID doesn't exist
  - On any error for approach queries → exclude this therapist`,
      inputSchema: GetInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: GetInput) => {
      try {
        const raw = await getTherapist(params.id);

        // Handle both { data: Therapist } and bare Therapist responses
        const therapist: Therapist =
          "data" in raw && raw.data ? (raw as { data: Therapist }).data : (raw as Therapist);

        let text: string;
        if (params.response_format === ResponseFormat.JSON) {
          text = JSON.stringify(therapist, null, 2);
        } else {
          text = `# Terapist Profili\n\n${therapistToMarkdown(therapist)}`;
        }

        return {
          content: [{ type: "text", text }],
          structuredContent: therapist,
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // ── 3. list_specialties ──────────────────────────────────────────────────────
  server.registerTool(
    "list_specialties",
    {
      title: "List Specialties",
      description: `Returns all therapy specialty areas available on the Planda marketplace.

Call this FIRST before find_therapists to identify the specialty IDs that match
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
    },
    async () => {
      try {
        const specialties = await getCachedSpecialties(); // still uses local cache wrapper

        const text = specialties.length
          ? specialties
              .map((s) => {
                const sp = s as { id: number; name: string };
                return `- ID ${sp.id}: ${sp.name}`;
              })
              .join("\n")
          : "Uzmanlık alanı listesi alınamadı.";

        return {
          content: [{ type: "text", text: `# Planda Uzmanlık Alanları\n\n${text}` }],
          structuredContent: { specialties },
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // ── 4. get_therapist_hours ───────────────────────────────────────────────────
  const HoursInputSchema = z
    .object({
      therapist_id: z
        .union([z.string(), z.number()])
        .describe("The therapist's unique ID (from find_therapists or get_therapist)"),
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

  type HoursInput = z.infer<typeof HoursInputSchema>;

  server.registerTool(
    "get_therapist_hours",
    {
      title: "Get Therapist Available Hours",
      description: `Returns bookable appointment time slots for a therapist on a specific date.

⚠️ ALWAYS pass branch_id AND service_id — without both, the API returns wrong or no slots.
  - branch_id: from therapist's branches[].id
  - service_id: from therapist's services[].id (e.g. Bireysel Terapi)

Workflow:
  1. find_therapists → get therapist id, branches[], services[]
  2. get_therapist_available_days(therapist_id, branch_id) → pick a date
  3. get_therapist_hours(therapist_id, date, branch_id, service_id) → get exact slots

Returns:
  Array of bookable times: ["12:00", "12:30", "13:00", ...]`,
      inputSchema: HoursInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: HoursInput) => {
      try {
        const raw = await apiGetTherapistHours({
          therapist_id: params.therapist_id,
          date: params.date,
          branch_id: params.branch_id,
          service_id: params.service_id,
        });

        // Normalise — API may return array or { data: [...] } or { hours: [...] }
        const slots: unknown[] = Array.isArray(raw)
          ? raw
          : Array.isArray((raw as { data?: unknown[] }).data)
          ? (raw as { data: unknown[] }).data
          : Array.isArray((raw as { hours?: unknown[] }).hours)
          ? (raw as { hours: unknown[] }).hours
          : [];

        if (!slots.length) {
          return {
            content: [{ type: "text", text: `${params.date} tarihinde müsait saat bulunamadı.` }],
            structuredContent: { date: params.date, slots: [] },
          };
        }

        const lines = [`# Müsait Saatler — ${params.date}`, ""];
        slots.forEach((slot) => {
          const s = slot as Record<string, unknown>;
          // Handle common slot shapes: { time }, { start_time }, { start }, { slot }
          const time =
            (s["time"] ?? s["start_time"] ?? s["start"] ?? s["slot"] ?? JSON.stringify(s)) as string;
          lines.push(`- ${time}`);
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { date: params.date, slots },
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // ── 5. get_therapist_available_days ─────────────────────────────────────────
  const AvailableDaysInputSchema = z
    .object({
      therapist_id: z
        .union([z.string(), z.number()])
        .describe("The therapist's unique ID (from find_therapists)"),
      branch_id: z
        .union([z.string(), z.number()])
        .describe("Branch ID (from therapist's branches[].id — use physical branch for in-person, online branch for online sessions)"),
    })
    .strict();

  type AvailableDaysInput = z.infer<typeof AvailableDaysInputSchema>;

  server.registerTool(
    "get_therapist_available_days",
    {
      title: "Get Therapist Available Days",
      description: `Returns the dates (days) on which a therapist has availability at a specific branch.

Use this BEFORE get_therapist_hours to find which days have open slots.

Workflow:
  1. find_therapists → find therapist by name → get id and branches[]
  2. get_therapist_available_days(therapist_id, branch_id) → get available dates
  3. get_therapist_hours(therapist_id, date, branch_id) → get hours for a specific date

Args:
  - therapist_id: therapist's numeric id
  - branch_id: branch id from therapist's branches[] array
    • Use physical branch id for in-person sessions
    • Use online branch id for online sessions

Returns:
  List of available dates (YYYY-MM-DD format).`,
      inputSchema: AvailableDaysInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: AvailableDaysInput) => {
      try {
        const raw = await apiGetTherapistAvailableDays({
          therapist_id: params.therapist_id,
          branch_id: params.branch_id,
        });

        // Normalise — API may return array or { data: [...] } or { days: [...] }
        const days: unknown[] = Array.isArray(raw)
          ? raw
          : Array.isArray((raw as { data?: unknown[] }).data)
          ? (raw as { data: unknown[] }).data
          : Array.isArray((raw as { days?: unknown[] }).days)
          ? (raw as { days: unknown[] }).days
          : [];

        if (!days.length) {
          return {
            content: [{ type: "text", text: "Bu şube için müsait gün bulunamadı." }],
            structuredContent: { days: [] },
          };
        }

        const lines = ["# Müsait Günler", ""];
        days.forEach((day) => {
          // Day may be a string ("2025-05-20") or an object { date: "..." }
          const dateStr =
            typeof day === "string"
              ? day
              : ((day as Record<string, unknown>)["date"] ??
                 (day as Record<string, unknown>)["day"] ??
                 JSON.stringify(day)) as string;
          lines.push(`- ${dateStr}`);
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { days },
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // ── 6. get_active_cities ─────────────────────────────────────────────────────
  server.registerTool(
    "get_active_cities",
    {
      title: "Get Active Cities",
      description: `Returns the list of cities where Planda therapists are currently active.

Use this to:
  - Validate or normalise a city name the user mentioned (e.g. "istanbul" → "İstanbul")
  - Suggest available cities when the user hasn't specified one
  - Confirm whether in-person therapy is available in a given city

Returns:
  Array of city names (Turkish, correctly capitalised).`,
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const raw = await apiGetActiveCities();
        const cities: unknown[] = Array.isArray(raw)
          ? raw
          : Array.isArray((raw as { data?: unknown[] }).data)
          ? (raw as { data: unknown[] }).data
          : [];

        if (!cities.length) {
          return { content: [{ type: "text", text: "Aktif şehir listesi alınamadı." }] };
        }

        const names = cities.map((c) => {
          if (typeof c === "string") return c;
          const obj = c as Record<string, unknown>;
          return String(obj["name"] ?? obj["city"] ?? JSON.stringify(c));
        });

        return {
          content: [{ type: "text", text: `# Planda Aktif Şehirler\n\n${names.map((n) => `- ${n}`).join("\n")}` }],
          structuredContent: { cities: names },
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );
}
