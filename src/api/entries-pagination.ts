import type { ApiEntry } from "../types/models";
import { mapEntryFromApi } from "./mappers";

type ApiRequestFn = (path: string, options?: RequestInit) => Promise<unknown>;

/**
 * Loads all entries in bounded pages so each response stays small and the main thread can yield between parses.
 */
export async function fetchAllEntriesPaged(
  apiRequest: ApiRequestFn,
  opts?: { pageSize?: number; maxEntries?: number },
): Promise<ReturnType<typeof mapEntryFromApi>[]> {
  const pageSize = Math.min(1000, Math.max(1, opts?.pageSize ?? 500));
  const maxEntries = opts?.maxEntries ?? 25_000;
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  const all: ReturnType<typeof mapEntryFromApi>[] = [];

  while (offset < total && all.length < maxEntries) {
    const resp = (await apiRequest(`/entries?limit=${pageSize}&offset=${offset}`)) as {
      items?: ApiEntry[];
      total?: number;
    };
    const items = Array.isArray(resp?.items) ? resp.items : [];
    if (typeof resp?.total === "number") total = resp.total;

    for (const item of items) {
      all.push(mapEntryFromApi(item));
    }

    if (items.length === 0) break;
    offset += items.length;
    if (items.length < pageSize) break;
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });
  }

  all.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return all;
}
