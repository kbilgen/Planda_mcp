/**
 * Planda REST API Routes — iOS & Mobile Clients
 *
 * Exposes the Planda marketplace data as a simple REST API so that
 * mobile apps (iOS, Android) can consume it without implementing MCP.
 *
 * Endpoints:
 *   GET /api/therapists          — paginated list with optional filters
 *   GET /api/therapists/search   — free-text search
 *   GET /api/therapists/:id      — single therapist profile
 *   GET /api/specialties         — full specialty catalogue
 *
 * All responses follow the same envelope:
 *   Success: { data: T, pagination?: {...} }
 *   Error:   { error: { code: string, message: string } }
 */

import { Router, Request, Response } from "express";
import { makeApiRequest, handleApiError } from "../services/apiClient.js";
import {
  Therapist,
  TherapistListResponse,
  TherapistListOutput,
} from "../types.js";

export const therapistRouter = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function apiError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/** Normalises various list-response shapes from the Planda API */
function normaliseList(
  raw: TherapistListResponse,
  page: number,
  perPage: number
): TherapistListOutput {
  const therapists: Therapist[] =
    raw.data ?? raw.therapists ?? raw.results ?? [];
  const total = raw.meta?.total ?? raw.total ?? raw.count ?? therapists.length;
  const lastPage = raw.meta?.last_page ?? Math.ceil(total / perPage);
  const hasMore = page < lastPage;
  return {
    total,
    count: therapists.length,
    page,
    per_page: perPage,
    has_more: hasMore,
    next_page: hasMore ? page + 1 : null,
    therapists,
  };
}

/** Scores a therapist against a list of search terms (higher = better match) */
function scoreTherapist(t: Therapist, terms: string[]): number {
  let score = 0;
  const fullName = (
    t.full_name ?? [t.name, t.surname].filter(Boolean).join(" ")
  ).toLowerCase();
  const specialtyText = (t.specialties ?? []).map((s) => s.name).join(" ").toLowerCase();
  const bioText = t.data?.introduction_letter
    ? t.data.introduction_letter.replace(/<[^>]+>/g, " ").toLowerCase()
    : "";
  const cityText = (t.branches ?? []).map((b) => b.city?.name ?? "").join(" ").toLowerCase();

  for (const term of terms) {
    if (fullName.includes(term)) score += 10;
    if (specialtyText.includes(term)) score += 6;
    if (cityText.includes(term)) score += 4;
    if (bioText.includes(term)) score += 1;
  }
  return score;
}

// ─── GET /api/therapists ──────────────────────────────────────────────────────
//
// Query params:
//   page     (number, default 1)
//   per_page (number, default 20, max 100)
//   city     (string) — only confirmed server-side filter
//
// Response: { data: Therapist[], pagination: { page, perPage, total, totalPages } }

therapistRouter.get("/therapists", async (req: Request, res: Response) => {
  try {
    const page    = Math.max(1, parseInt(String(req.query["page"]    ?? "1"),  10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(String(req.query["per_page"] ?? "20"), 10) || 20));
    const city    = typeof req.query["city"] === "string" ? req.query["city"] : undefined;

    const params: Record<string, unknown> = { page, per_page: perPage };
    if (city) params["city"] = city;

    const raw = await makeApiRequest<TherapistListResponse>(
      "marketplace/therapists",
      "GET",
      undefined,
      params
    );

    const out = normaliseList(raw, page, perPage);

    res.json({
      data: out.therapists,
      pagination: {
        page: out.page,
        perPage: out.per_page,
        total: out.total,
        totalPages: Math.ceil(out.total / out.per_page),
      },
    });
  } catch (err) {
    const msg = handleApiError(err);
    apiError(res, 502, "UPSTREAM_ERROR", msg);
  }
});

// ─── GET /api/therapists/search ───────────────────────────────────────────────
//
// Query params:
//   q        (string, required) — free-text query
//   city     (string, optional) — city pre-filter
//
// Fetches all therapists then filters client-side (API has no server-side search).
// Response: { data: Therapist[], total: number, query: string }

therapistRouter.get("/therapists/search", async (req: Request, res: Response) => {
  const q = typeof req.query["q"] === "string" ? req.query["q"].trim() : "";
  if (!q) {
    apiError(res, 422, "VALIDATION_ERROR", 'Query parameter "q" is required');
    return;
  }

  const city = typeof req.query["city"] === "string" ? req.query["city"] : undefined;

  try {
    const params: Record<string, unknown> = { page: 1, per_page: 100 };
    if (city) params["city"] = city;

    const raw = await makeApiRequest<TherapistListResponse>(
      "marketplace/therapists",
      "GET",
      undefined,
      params
    );

    const all = normaliseList(raw, 1, 100);
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);

    const matched = all.therapists
      .map((t) => ({ t, score: scoreTherapist(t, terms) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ t }) => t);

    res.json({ data: matched, total: matched.length, query: q });
  } catch (err) {
    const msg = handleApiError(err);
    apiError(res, 502, "UPSTREAM_ERROR", msg);
  }
});

// ─── GET /api/therapists/:id ──────────────────────────────────────────────────
//
// Path param: id (string or number)
// Response: { data: Therapist }

therapistRouter.get("/therapists/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) {
    apiError(res, 400, "BAD_REQUEST", "Therapist ID is required");
    return;
  }

  try {
    const raw = await makeApiRequest<Therapist | { data: Therapist }>(
      `marketplace/therapists/${id}`
    );

    const therapist: Therapist =
      "data" in raw && (raw as { data?: Therapist }).data
        ? (raw as { data: Therapist }).data
        : (raw as Therapist);

    res.json({ data: therapist });
  } catch (err) {
    const msg = handleApiError(err);
    if (msg.includes("not found") || msg.includes("404")) {
      apiError(res, 404, "NOT_FOUND", `Therapist with id "${id}" not found`);
    } else {
      apiError(res, 502, "UPSTREAM_ERROR", msg);
    }
  }
});

// ─── GET /api/specialties ─────────────────────────────────────────────────────
//
// Response: { data: Array<{ id: number, name: string }> }

therapistRouter.get("/specialties", async (_req: Request, res: Response) => {
  try {
    const raw = await makeApiRequest<unknown>("marketplace/specialties");

    const specialties = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { data?: unknown[] }).data)
      ? (raw as { data: unknown[] }).data
      : [];

    res.json({ data: specialties });
  } catch (err) {
    const msg = handleApiError(err);
    apiError(res, 502, "UPSTREAM_ERROR", msg);
  }
});
