/**
 * Planda MCP Server — Shared API client
 */

import axios, { AxiosError } from "axios";
import { API_BASE_URL, REQUEST_TIMEOUT_MS } from "../constants.js";

export async function makeApiRequest<T>(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown,
  params?: Record<string, unknown>
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const response = await axios({
    method,
    url: `${API_BASE_URL}/${endpoint}`,
    data: body,
    params,
    timeout: REQUEST_TIMEOUT_MS,
    headers,
  });

  return response.data as T;
}

/**
 * Converts any caught error into a human-readable, actionable string for the
 * MCP tool response.
 */
export function handleApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axiosErr = error as AxiosError;
    if (axiosErr.response) {
      const status = axiosErr.response.status;
      const detail =
        (axiosErr.response.data as Record<string, unknown>)?.detail ??
        (axiosErr.response.data as Record<string, unknown>)?.message ??
        axiosErr.message;

      switch (status) {
        case 400:
          return `Error: Bad request — ${detail}. Please check your parameters.`;
        case 401:
          return "Error: Unauthorized. Set the PLANDA_API_KEY environment variable with a valid token.";
        case 403:
          return "Error: Forbidden. You don't have permission to access this resource.";
        case 404:
          return "Error: Resource not found. Please verify the ID or endpoint.";
        case 422:
          return `Error: Validation error — ${detail}. Please check your input parameters.`;
        case 429:
          return "Error: Rate limit exceeded. Please wait a moment before retrying.";
        case 500:
          return "Error: Planda server error. Please try again later.";
        default:
          return `Error: API request failed with HTTP ${status} — ${detail}`;
      }
    }

    if (axiosErr.code === "ECONNABORTED") {
      return "Error: Request timed out. The Planda API took too long to respond. Please retry.";
    }

    if (axiosErr.code === "ENOTFOUND" || axiosErr.code === "ECONNREFUSED") {
      return "Error: Unable to reach the Planda API. Check your network connection.";
    }
  }

  return `Error: Unexpected error — ${error instanceof Error ? error.message : String(error)}`;
}
