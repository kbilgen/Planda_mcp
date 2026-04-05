/**
 * Planda MCP Server — Therapist Tools
 *
 * Registers four tools on the provided McpServer instance:
 *   1. planda_list_therapists   — paginated list with optional filters
 *   2. planda_get_therapist     — single therapist detail by ID
 *   3. planda_search_therapists — keyword / criteria search
 *   4. planda_check_availability — lightweight count check for dynamic conversation
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { makeApiRequest, handleApiError } from "../services/apiClient.js";
import { CHARACTER_LIMIT } from "../constants.js";
import {
  ResponseFormat,
  Therapist,
  TherapistListResponse,
  TherapistListOutput,
} from "../types.js";

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
    .describe("Number of results per page (1–10000, default 50). Use higher values like 200–500 to get a broad candidate pool for matching."),
});

const FilterSchema = z.object({
  search_query: z
    .string()
    .optional()
    .describe('Free-text search across therapist names, bios, and specialties, e.g. "kaygı", "travma", "çift terapisi"'),
  specialties: z
    .string()
    .optional()
    .describe('Filter by specialty slug(s). Comma-separated for multiple, e.g. "anxiety,depression" or "couples-therapy"'),
  field: z
    .string()
    .optional()
    .describe('Filter by field slug, e.g. "psychology", "psychiatry"'),
  service: z
    .string()
    .optional()
    .describe('Filter by service category slug, e.g. "individual-therapy", "couples-therapy", "child-therapy"'),
  city: z
    .string()
    .optional()
    .describe('Filter by city, e.g. "Istanbul", "Ankara"'),
  online: z
    .boolean()
    .optional()
    .describe("true → online-only sessions; false → in-person only; omit for both"),
  gender: z
    .string()
    .optional()
    .describe('Filter by therapist gender, e.g. "female", "male"'),
  min_price: z
    .number()
    .optional()
    .describe("Minimum session price (inclusive)"),
  max_price: z
    .number()
    .optional()
    .describe("Maximum session price (inclusive)"),
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

/** Renders a single therapist as Markdown using the real API structure */
function therapistToMarkdown(t: Therapist, index?: number): string {
  const prefix = index !== undefined ? `### ${index + 1}. ` : "## ";
  const lines: string[] = [];

  const displayName = t.full_name ?? `${t.name}${t.surname ? " " + t.surname : ""}`;
  lines.push(`${prefix}${displayName} *(ID: ${t.id})*`);

  // Title from nested data
  const titleName = t.data?.title?.name;
  if (titleName) lines.push(`**Unvan:** ${titleName}`);

  // Specialties — now [{id, name}] objects
  const specialties = Array.isArray(t.specialties)
    ? t.specialties.map((s) => (typeof s === "object" && s !== null ? s.name : String(s))).filter(Boolean)
    : [];
  if (specialties.length) lines.push(`**Uzmanlık:** ${specialties.join(", ")}`);

  // Education from nested universities
  const edu: string[] = [];
  if (t.data?.undergraduateUniversity?.name) edu.push(`Lisans: ${t.data.undergraduateUniversity.name}`);
  if (t.data?.postgraduateUniversity?.name) edu.push(`Y.Lisans: ${t.data.postgraduateUniversity.name}`);
  if (t.data?.doctorateUniversity?.name) edu.push(`Doktora: ${t.data.doctorateUniversity.name}`);
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

  // Services / pricing
  if (t.services?.length) {
    const serviceLines = t.services.map((s) => {
      const fee = s.custom_fee ?? s.fee;
      return `${s.name}: ${fee ? fee + " TL" : "belirtilmemiş"} (${s.category?.name ?? ""})`;
    });
    lines.push(`**Hizmetler:** ${serviceLines.join(" | ")}`);
  }

  // Profile URL from username
  if (t.username) {
    lines.push(`\n🔗 [Uzman Profiline Git](https://www.planda.org/uzmanlar/${t.username})`);
  }

  // Bio — strip HTML, truncate to 400 chars
  const rawBio = t.data?.introduction_letter;
  if (rawBio) {
    const cleanBio = stripHtml(rawBio);
    const shortBio = cleanBio.length > 400 ? cleanBio.slice(0, 397) + "..." : cleanBio;
    lines.push(`\n> ${shortBio.replace(/\n/g, "\n> ")}`);
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

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerTherapistTools(server: McpServer): void {
  // ── 1. planda_list_therapists ────────────────────────────────────────────────
  const ListInputSchema = PaginationSchema.merge(FilterSchema)
    .merge(FormatSchema)
    .strict();

  type ListInput = z.infer<typeof ListInputSchema>;

  server.registerTool(
    "planda_list_therapists",
    {
      title: "List Planda Therapists",
      description: `Returns a paginated list of therapists from the Planda marketplace.

Use this to get a broad candidate pool, then call planda_get_therapist on top candidates for deep profile analysis.

Args:
  - page (number): Page number, starts at 1 (default: 1)
  - per_page (number): Results per page, 1–10000 (default: 50). Use 100–200 for broad matching.
  - search_query (string, optional): Free-text search across names, bios, specialties
  - specialties (string, optional): Specialty slug(s), comma-separated
  - field (string, optional): Field slug, e.g. "psychology", "psychiatry"
  - service (string, optional): Service category slug, e.g. "individual-therapy", "couples-therapy", "child-therapy"
  - city (string, optional): e.g. "Istanbul", "Ankara"
  - online (boolean, optional): true for online-only, false for in-person only
  - gender (string, optional): e.g. "female", "male"
  - min_price / max_price (number, optional): Price range filter
  - response_format ("markdown" | "json"): Output format (default: "markdown")

Returns:
  List of therapists with name, specialty, location, pricing, rating, and bio.`,
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
        // Build query params — omit undefined values
        const query: Record<string, unknown> = {
          page: params.page,
          per_page: params.per_page,
        };
        if (params.search_query) query["search_query"] = params.search_query;
        if (params.specialties) query["specialties"] = params.specialties;
        if (params.field) query["field"] = params.field;
        if (params.service) query["service"] = params.service;
        if (params.city) query["city"] = params.city;
        if (params.online !== undefined) query["online"] = params.online;
        if (params.gender) query["gender"] = params.gender;
        if (params.min_price !== undefined) query["min_price"] = params.min_price;
        if (params.max_price !== undefined) query["max_price"] = params.max_price;

        const raw = await makeApiRequest<TherapistListResponse>(
          "marketplace/therapists",
          "GET",
          undefined,
          query
        );

        let output = normaliseListResponse(raw, params.page, params.per_page);
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
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // ── 2. planda_get_therapist ──────────────────────────────────────────────────
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
    "planda_get_therapist",
    {
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
    },
    async (params: GetInput) => {
      try {
        const raw = await makeApiRequest<Therapist | { data: Therapist }>(
          `marketplace/therapists/${params.id}`
        );

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
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // ── 3. planda_search_therapists ─────────────────────────────────────────────
  const SearchInputSchema = z
    .object({
      query: z
        .string()
        .min(2, "Arama terimi en az 2 karakter olmalıdır")
        .max(200, "Arama terimi en fazla 200 karakter olabilir")
        .describe(
          'Free-text search query, e.g. "kaygı tedavisi", "bilişsel davranışçı terapi", "çift terapisi Istanbul"'
        ),
      page: z.number().int().min(1).default(1).describe("Page number (starts at 1)"),
      per_page: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .default(50)
        .describe("Results per page (1–10000, default 50)"),
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe(
          'Output format: "markdown" for human-readable, "json" for structured data'
        ),
    })
    .strict();

  type SearchInput = z.infer<typeof SearchInputSchema>;

  server.registerTool(
    "planda_search_therapists",
    {
      title: "Search Planda Therapists",
      description: `Performs a free-text search across therapist profiles in the Planda marketplace.

Use this tool for natural-language queries that don't map to a single filter field, such as "therapists who specialise in trauma and work with adolescents".

Args:
  - query (string, min 2 chars): Search term(s) to match against therapist names, bios, and specialties
  - page (number): Page number, starts at 1 (default: 1)
  - per_page (number): Results per page, 1–10000 (default: 50)
  - response_format ("markdown" | "json"): Output format (default: "markdown")

Returns:
  Ranked list of therapists matching the query, with name, specialty, location, pricing, and rating.

Examples:
  - "Find therapists for trauma and PTSD" → query="trauma PTSD"
  - "Search for cognitive behavioural therapists in Ankara" → query="cognitive behavioural Ankara"
  - "Kaygı bozukluğu uzmanı terapist ara" → query="kaygı bozukluğu"

Error Handling:
  - Returns empty list message when no therapists match the query`,
      inputSchema: SearchInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: SearchInput) => {
      try {
        const raw = await makeApiRequest<TherapistListResponse>(
          "marketplace/therapists",
          "GET",
          undefined,
          {
            search_query: params.query,
            page: params.page,
            per_page: params.per_page,
          }
        );

        let output = normaliseListResponse(raw, params.page, params.per_page);
        output = applyCharacterLimit(output);

        if (!output.therapists.length) {
          return {
            content: [
              {
                type: "text",
                text: `"${params.query}" araması için sonuç bulunamadı. Farklı anahtar kelimeler deneyin.`,
              },
            ],
          };
        }

        let text: string;
        if (params.response_format === ResponseFormat.JSON) {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [
            `# "${params.query}" Arama Sonuçları`,
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
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );

  // ── 4. planda_check_availability ────────────────────────────────────────────
  // Used to dynamically validate options before asking the user follow-up questions.
  const CheckSchema = z
    .object({
      city: z.string().optional().describe("City to check therapist availability for"),
      online: z.boolean().optional().describe("Check online therapist count"),
      search_query: z.string().optional().describe("Problem/specialty term to check"),
      service: z.string().optional().describe("Service category slug"),
    })
    .strict();

  type CheckInput = z.infer<typeof CheckSchema>;

  server.registerTool(
    "planda_check_availability",
    {
      title: "Check Therapist Availability",
      description: `Quickly checks how many therapists are available for given criteria WITHOUT returning full profiles.

Use this BEFORE asking the user follow-up questions, to validate options and shape the conversation:
- Check if a city has therapists before asking for city preference
- Check if online therapists exist for a problem before suggesting online option
- Check counts for different cities to guide the user toward better options

Args:
  - city (string, optional): City name to check
  - online (boolean, optional): Check online availability
  - search_query (string, optional): Problem or specialty term
  - service (string, optional): Service category slug

Returns:
  Count of available therapists matching the criteria. Use this to decide what to ask next.`,
      inputSchema: CheckSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: CheckInput) => {
      try {
        const query: Record<string, unknown> = { per_page: 1, page: 1 };
        if (params.city) query["city"] = params.city;
        if (params.online !== undefined) query["online"] = params.online;
        if (params.search_query) query["search_query"] = params.search_query;
        if (params.service) query["service"] = params.service;

        const raw = await makeApiRequest<TherapistListResponse>(
          "marketplace/therapists",
          "GET",
          undefined,
          query
        );

        const total = raw.meta?.total ?? raw.total ?? raw.count ?? (raw.data ?? raw.therapists ?? raw.results ?? []).length;

        const filters: string[] = [];
        if (params.city) filters.push(`şehir: ${params.city}`);
        if (params.online !== undefined) filters.push(params.online ? "online" : "yüz yüze");
        if (params.search_query) filters.push(`arama: "${params.search_query}"`);
        if (params.service) filters.push(`hizmet: ${params.service}`);

        const filterStr = filters.length ? filters.join(", ") : "filtre yok";

        return {
          content: [{
            type: "text",
            text: `Uygun terapist sayısı (${filterStr}): ${total}`,
          }],
          structuredContent: { total, filters: params },
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }] };
      }
    }
  );
}
