/**
 * API base. Prefer `localhost` (not `127.0.0.1`) so the backend shares the same
 * site as the Vite dev server for `SameSite=Lax` cookies.
 * Set `VITE_API_BASE` to override (include `/api` suffix).
 */
export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8787/api";

/** Origin for uploads and /media (no /api suffix). */
export const API_ORIGIN = API_BASE.replace(/\/api\/?$/i, "") || "http://localhost:8787";
