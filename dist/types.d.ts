/**
 * Planda MCP Server — TypeScript type definitions
 */
/** Response format for tool output */
export declare enum ResponseFormat {
    MARKDOWN = "markdown",
    JSON = "json"
}
/** A single therapist entry returned by the Planda marketplace API */
export interface Therapist {
    id: string | number;
    name: string;
    title?: string;
    specialty?: string | string[];
    specialties?: string[];
    languages?: string[];
    location?: string;
    city?: string;
    country?: string;
    online?: boolean;
    price?: number | string;
    price_per_session?: number | string;
    currency?: string;
    rating?: number;
    review_count?: number;
    experience_years?: number;
    bio?: string;
    profile_url?: string;
    avatar_url?: string;
    available?: boolean;
    gender?: string;
    approach?: string | string[];
    education?: string;
    [key: string]: unknown;
}
/** Paginated list response shape */
export interface TherapistListResponse {
    data?: Therapist[];
    therapists?: Therapist[];
    results?: Therapist[];
    total?: number;
    count?: number;
    page?: number;
    per_page?: number;
    total_pages?: number;
    next?: string | null;
    previous?: string | null;
    [key: string]: unknown;
}
/** Normalised, pagination-aware output shape returned by tools */
export interface TherapistListOutput {
    total: number;
    count: number;
    page: number;
    per_page: number;
    has_more: boolean;
    next_page: number | null;
    therapists: Therapist[];
    truncated?: boolean;
    truncation_message?: string;
    [key: string]: unknown;
}
//# sourceMappingURL=types.d.ts.map