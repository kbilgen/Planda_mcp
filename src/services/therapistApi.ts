/**
 * Planda Therapist API — shared by MCP tools and Claude workflow path.
 * Single source of truth for all Planda marketplace API calls.
 */

import { makeApiRequest } from "./apiClient.js";
import type { TherapistListResponse, Therapist } from "../types.js";

export async function findTherapists(params: {
  page?: number;
  per_page?: number;
  city?: string;
}): Promise<TherapistListResponse> {
  const query: Record<string, unknown> = {
    page: params.page ?? 1,
    per_page: params.per_page ?? 50,
  };
  if (params.city) query["city"] = params.city;
  return makeApiRequest<TherapistListResponse>("marketplace/therapists", "GET", undefined, query);
}

export async function getTherapist(id: string | number): Promise<Therapist | { data: Therapist }> {
  return makeApiRequest<Therapist | { data: Therapist }>(`marketplace/therapists/${id}`);
}

export async function listSpecialties(): Promise<unknown> {
  return makeApiRequest<unknown>("marketplace/specialties");
}

export async function getTherapistHours(params: {
  therapist_id: string | number;
  date: string;
  branch_id?: number;
  service_id?: number;
}): Promise<unknown> {
  const query: Record<string, unknown> = { date: params.date };
  if (params.branch_id !== undefined) query["branch_id"] = params.branch_id;
  if (params.service_id !== undefined) query["service_id"] = params.service_id;
  return makeApiRequest<unknown>(
    `marketplace/therapists/${params.therapist_id}/hours`,
    "GET",
    undefined,
    query
  );
}

export async function getTherapistAvailableDays(params: {
  therapist_id: string | number;
  branch_id: string | number;
}): Promise<unknown> {
  return makeApiRequest<unknown>(
    `marketplace/therapists/${params.therapist_id}/branches/${params.branch_id}/days`
  );
}
