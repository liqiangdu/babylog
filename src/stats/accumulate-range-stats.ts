import { toLocalDateKey } from "../lib/dates";
import type { LogEntry } from "../types/models";

function entryTimeMs(e: LogEntry): number {
  return new Date(e.at).getTime();
}

/** Single-pass aggregates for the stats UI (current or comparison range). */
export function accumulateRangeStats(entries: LogEntry[]) {
  const dayKeys = new Set<string>();
  let latestTempEntry: LogEntry | null = null;
  let latestGrowthEntry: LogEntry | null = null;

  const acc = {
    feedMl: 0,
    sleepMin: 0,
    wetCount: 0,
    dirtyCount: 0,
    diaperCount: 0,
    bathCount: 0,
    medicineCount: 0,
    solidCount: 0,
    spitupCount: 0,
    supplementCount: 0,
    pumpCount: 0,
    pumpMl: 0,
    customCount: 0,
    tummyMin: 0,
    outdoorMin: 0,
    cryMin: 0,
    tempCount: 0,
    growthCount: 0,
  };

  for (const e of entries) {
    dayKeys.add(toLocalDateKey(e.at));
    const cid = e.categoryId;
    const f = e.fields || {};
    if (cid === "feeding") acc.feedMl += Number(f.amountMl) || 0;
    else if (cid === "sleep") acc.sleepMin += Number(f.durationMin) || 0;
    else if (cid === "diaper") {
      acc.diaperCount += 1;
      const st = String(f.subtype || "");
      if (st === "wet" || st === "both") acc.wetCount += 1;
      if (st === "dirty" || st === "both") acc.dirtyCount += 1;
    } else if (cid === "bath") acc.bathCount += 1;
    else if (cid === "medicine") acc.medicineCount += 1;
    else if (cid === "solid") acc.solidCount += 1;
    else if (cid === "spitup") acc.spitupCount += 1;
    else if (cid === "supplement") acc.supplementCount += 1;
    else if (cid === "pump") {
      acc.pumpCount += 1;
      acc.pumpMl += Number(f.amountMl) || 0;
    } else if (cid === "custom") acc.customCount += 1;
    else if (cid === "tummy_time") acc.tummyMin += Number(f.durationMin) || 0;
    else if (cid === "outdoor") acc.outdoorMin += Number(f.durationMin) || 0;
    else if (cid === "cry") acc.cryMin += Number(f.durationMin) || 0;
    else if (cid === "temperature") {
      acc.tempCount += 1;
      if (!latestTempEntry || entryTimeMs(e) > entryTimeMs(latestTempEntry)) latestTempEntry = e;
    } else if (cid === "growth") {
      acc.growthCount += 1;
      if (!latestGrowthEntry || entryTimeMs(e) > entryTimeMs(latestGrowthEntry)) latestGrowthEntry = e;
    }
  }

  return { ...acc, dayKeys, latestTempEntry, latestGrowthEntry };
}

export type RangeStatsAccum = ReturnType<typeof accumulateRangeStats>;
