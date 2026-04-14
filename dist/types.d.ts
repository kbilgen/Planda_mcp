/**
 * Planda MCP Server — TypeScript type definitions
 * Matches the actual API response from /marketplace/therapists
 */
export declare enum ResponseFormat {
    MARKDOWN = "markdown",
    JSON = "json"
}
export interface TherapistTitle {
    id: number;
    name: string;
}
export interface TherapistOther {
    min_client_age?: string | number | null;
    max_client_age?: string | number | null;
    accept_all_ages?: boolean;
}
export interface University {
    id: number;
    name: string;
    city_id?: number;
}
export interface Department {
    id: number;
    name: string;
    degree: string;
}
export interface TherapistData {
    id?: number;
    user_id?: number;
    introduction_letter?: string | null;
    inform?: string | null;
    title?: TherapistTitle;
    other?: TherapistOther;
    gender?: "female" | "male" | string | null;
    contact_phone?: string | null;
    contact_email?: string | null;
    undergraduateUniversity?: University | null;
    postgraduateUniversity?: University | null;
    doctorateUniversity?: University | null;
    undergraduateDepartment?: Department | null;
    postgraduateDepartment?: Department | null;
    doctorateDepartment?: Department | null;
    rating?: number;
    weighted_rating?: number;
    [key: string]: unknown;
}
export interface Branch {
    id: number;
    type: "physical" | "online";
    name: string;
    short_name?: string | null;
    address?: string | null;
    second_address?: string | null;
    city?: {
        id: number;
        name: string;
    } | null;
}
export interface ServiceCategory {
    id: number;
    name: string;
    slug: string;
}
export interface Service {
    id: number;
    name: string;
    custom_duration?: number | null;
    fee?: string | null;
    custom_fee?: string | null;
    category?: ServiceCategory;
}
export interface Specialty {
    id: number;
    name: string;
}
export interface Approach {
    id: number;
    name: string;
}
export interface Tenant {
    id: number;
    name: string;
    slug: string;
    company_name: string;
    email?: string;
    phone_number?: string;
    logo?: string;
    thumbnail?: string;
    therapists_count?: number;
}
/** A single therapist entry returned by the Planda marketplace API */
export interface Therapist {
    id: number;
    name: string;
    surname?: string;
    full_name?: string;
    username?: string;
    profile_picture?: string | null;
    rating?: number | null;
    gender?: "female" | "male" | string | null;
    priority?: number | null;
    data?: TherapistData;
    branches?: Branch[];
    services?: Service[];
    specialties?: Specialty[];
    /** Therapy approaches — only present in planda_get_therapist detail response */
    approaches?: Approach[];
    /** Clinic/practice — only present in planda_get_therapist detail response */
    tenants?: Tenant[];
    campaigns?: unknown[];
    [key: string]: unknown;
}
/** Paginated list response shape */
export interface TherapistListResponse {
    data?: Therapist[];
    therapists?: Therapist[];
    results?: Therapist[];
    total?: number;
    count?: number;
    meta?: {
        current_page: number;
        last_page: number;
        per_page: number;
        total: number;
    };
    links?: {
        next?: string | null;
        prev?: string | null;
    };
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