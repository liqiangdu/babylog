import type { ApiEntry, LogEntry } from "../types/models";

export function mapEntryFromApi(item: ApiEntry): LogEntry {
  return {
    id: item.id,
    categoryId: item.category_id,
    at: item.at,
    fields: (item.fields || {}) as LogEntry["fields"],
    note: item.note || "",
    photos: Array.isArray(item.photos) ? item.photos : [],
  };
}

export function mapEntryToApi(item: LogEntry): ApiEntry {
  return {
    id: item.id,
    category_id: item.categoryId,
    at: item.at,
    fields: item.fields || {},
    note: item.note || "",
    photos: Array.isArray(item.photos) ? item.photos : [],
  };
}
