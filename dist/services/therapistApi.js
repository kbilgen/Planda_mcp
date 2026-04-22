/**
 * Planda Therapist API — shared by MCP tools and Claude workflow path.
 * Single source of truth for all Planda marketplace API calls.
 */
import { makeApiRequest } from "./apiClient.js";
export async function findTherapists(params) {
    const query = {
        page: params.page ?? 1,
        per_page: params.per_page ?? 50,
    };
    if (params.city)
        query["city"] = params.city;
    if (params.specialty_id)
        query["specialty_id"] = params.specialty_id;
    if (params.service_id)
        query["service_id"] = params.service_id;
    return makeApiRequest("marketplace/therapists", "GET", undefined, query);
}
export async function getTherapist(id) {
    return makeApiRequest(`marketplace/therapists/${id}`);
}
export async function listSpecialties() {
    return makeApiRequest("marketplace/specialties");
}
export async function getTherapistHours(params) {
    const query = { date: params.date };
    if (params.branch_id !== undefined)
        query["branch_id"] = params.branch_id;
    if (params.service_id !== undefined)
        query["service_id"] = params.service_id;
    return makeApiRequest(`marketplace/therapists/${params.therapist_id}/hours`, "GET", undefined, query);
}
export async function getTherapistAvailableDays(params) {
    return makeApiRequest(`marketplace/therapists/${params.therapist_id}/branches/${params.branch_id}/days`);
}
export async function getActiveCities() {
    return makeApiRequest("marketplace/cities/active");
}
//# sourceMappingURL=therapistApi.js.map