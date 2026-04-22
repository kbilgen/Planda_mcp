/**
 * Planda Therapist API — shared by MCP tools and Claude workflow path.
 * Single source of truth for all Planda marketplace API calls.
 */
import type { TherapistListResponse, Therapist } from "../types.js";
export declare function findTherapists(params: {
    page?: number;
    per_page?: number;
    city?: string;
}): Promise<TherapistListResponse>;
export declare function getTherapist(id: string | number): Promise<Therapist | {
    data: Therapist;
}>;
export declare function listSpecialties(): Promise<unknown>;
export declare function getTherapistHours(params: {
    therapist_id: string | number;
    date: string;
    branch_id?: number;
    service_id?: number;
}): Promise<unknown>;
export declare function getTherapistAvailableDays(params: {
    therapist_id: string | number;
    branch_id: string | number;
}): Promise<unknown>;
//# sourceMappingURL=therapistApi.d.ts.map