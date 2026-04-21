import type { CategoryDef, LogEntry } from "../types/models";

export type GalleryPhotoRef = {
  entryId: string;
  at: string;
  categoryLabel: string;
  url: string;
};

export function collectGalleryPhotosFromEntries(
  entryList: LogEntry[],
  getCategory: (id: string) => CategoryDef,
): GalleryPhotoRef[] {
  const photos: GalleryPhotoRef[] = [];
  for (const entry of entryList) {
    const urls = Array.isArray(entry.photos) ? entry.photos : [];
    if (!urls.length) continue;
    const cat = getCategory(entry.categoryId);
    for (const url of urls) {
      photos.push({
        entryId: entry.id,
        at: entry.at,
        categoryLabel: cat.label,
        url,
      });
    }
  }
  return photos.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
