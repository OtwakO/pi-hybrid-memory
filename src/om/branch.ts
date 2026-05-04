// Branch utilities: entry indexing, memory state, observation coverage — ported from pi-observational-memory
import type {
  Entry,
  MemoryReflection,
  MemoryDetailsV4,
  ObservationEntryData,
  ObservationRecord,
  ReflectionRecord,
  SupportedMemoryDetails,
} from "../types.js";
import { OBSERVATION_CUSTOM_TYPE, isObservationEntryData, isReflectionRecord, isSupportedMemoryDetails } from "../types.js";
import { estimateEntryTokens } from "./tokens.js";

const RAW_TYPES = new Set(["message", "custom_message", "branch_summary"]);

export const isSourceEntry = (entry: Entry): boolean => RAW_TYPES.has(entry.type);

const isObservationEntry = (entry: Entry): boolean =>
  entry.type === "custom" && entry.customType === OBSERVATION_CUSTOM_TYPE;

export const findLastCompactionIndex = (entries: Entry[]): number => {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compaction") return i;
  }
  return -1;
};

export const lastObservationCoverEndIdx = (entries: Entry[]): number => {
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) idToIdx.set(entries[i].id, i);
  let maxIdx = -1;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!isObservationEntry(entry)) continue;
    if (!isObservationEntryData(entry.data)) continue;
    const coverIdx = idToIdx.get(entry.data.coversUpToId);
    if (coverIdx !== undefined && coverIdx > maxIdx) maxIdx = coverIdx;
  }
  return maxIdx;
};

const rawTokensFromIndex = (entries: Entry[], startIndex: number): number => {
  let total = 0;
  for (let i = Math.max(0, startIndex); i < entries.length; i++) {
    if (RAW_TYPES.has(entries[i].type)) total += estimateEntryTokens(entries[i]);
  }
  return total;
};

export const rawTokensSinceLastBound = (entries: Entry[]): number =>
  rawTokensFromIndex(entries, lastObservationCoverEndIdx(entries) + 1);

export const rawTokensSinceLastCompaction = (entries: Entry[]): number => {
  const compactionIdx = findLastCompactionIndex(entries);
  if (compactionIdx === -1) return rawTokensFromIndex(entries, 0);
  return rawTokensFromIndex(entries, liveTailStartIndex(entries));
};

const liveTailStartIndex = (entries: Entry[]): number => {
  const compactionIdx = findLastCompactionIndex(entries);
  if (compactionIdx === -1) return 0;
  const firstKept = entries[compactionIdx].firstKeptEntryId;
  if (!firstKept) throw new Error("compaction entry missing firstKeptEntryId");
  const firstKeptIdx = entries.findIndex((e) => e.id === firstKept);
  if (firstKeptIdx === -1) throw new Error(`firstKeptEntryId "${firstKept}" not found`);
  return firstKeptIdx;
};

export const firstRawIdAfter = (entries: Entry[], afterIndex: number): string | undefined => {
  for (let i = Math.max(0, afterIndex + 1); i < entries.length; i++) {
    if (RAW_TYPES.has(entries[i].type)) return entries[i].id;
  }
  return undefined;
};

export const gapRawEntries = (entries: Entry[], newFirstKeptEntryId: string): Entry[] => {
  const lastBoundIdx = lastObservationCoverEndIdx(entries);
  const newKeptIdx = entries.findIndex((e) => e.id === newFirstKeptEntryId);
  if (newKeptIdx === -1) return [];
  const result: Entry[] = [];
  for (let i = lastBoundIdx + 1; i < newKeptIdx; i++) {
    if (RAW_TYPES.has(entries[i].type)) result.push(entries[i]);
  }
  return result;
};

export const rawTailEntriesBetween = (entries: Entry[], fromId: string, untilId: string): Entry[] => {
  const fromIdx = entries.findIndex((e) => e.id === fromId);
  const untilIdx = entries.findIndex((e) => e.id === untilId);
  if (fromIdx === -1 || untilIdx === -1 || untilIdx < fromIdx) return [];
  const result: Entry[] = [];
  for (let i = fromIdx; i <= untilIdx; i++) {
    if (isSourceEntry(entries[i])) result.push(entries[i]);
  }
  return result;
};

const getPriorMemoryDetails = (entries: Entry[]): SupportedMemoryDetails | undefined => {
  const idx = findLastCompactionIndex(entries);
  if (idx === -1) return undefined;
  const details = entries[idx].details;
  return isSupportedMemoryDetails(details) ? details : undefined;
};

const collectObservationsPendingNextCompaction = (entries: Entry[]): ObservationEntryData[] => {
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) idToIdx.set(entries[i].id, i);

  const priorCompactionIdx = findLastCompactionIndex(entries);
  let thresholdIdx: number;
  if (priorCompactionIdx === -1) {
    thresholdIdx = -1;
  } else {
    const priorFirstKept = entries[priorCompactionIdx].firstKeptEntryId;
    if (!priorFirstKept) throw new Error("prior compaction entry missing firstKeptEntryId");
    const idx = idToIdx.get(priorFirstKept);
    if (idx === undefined) throw new Error(`prior firstKeptEntryId "${priorFirstKept}" not found`);
    thresholdIdx = idx;
  }

  const result: ObservationEntryData[] = [];
  for (const entry of entries) {
    if (!isObservationEntry(entry)) continue;
    if (!isObservationEntryData(entry.data)) continue;
    const fromIdx = idToIdx.get(entry.data.coversFromId);
    if (fromIdx === undefined) continue;
    if (fromIdx >= thresholdIdx) result.push(entry.data);
  }
  return result;
};

export interface MemoryState {
  reflections: MemoryReflection[];
  committedObs: ObservationRecord[];
  pendingObs: ObservationRecord[];
}

export const getMemoryState = (entries: Entry[]): MemoryState => {
  const priorDetails = getPriorMemoryDetails(entries);
  const pendingData = collectObservationsPendingNextCompaction(entries);
  return {
    reflections: priorDetails?.reflections ?? [],
    committedObs: priorDetails?.observations ?? [],
    pendingObs: pendingData.flatMap((d) => d.records),
  };
};

export const collectObservationsByCoverage = (
  entries: Entry[],
  priorFirstKeptEntryId: string | undefined,
  newFirstKeptEntryId: string,
): ObservationEntryData[] => {
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) idToIdx.set(entries[i].id, i);

  const newFKIIdx = idToIdx.get(newFirstKeptEntryId);
  if (newFKIIdx === undefined) return [];

  let priorFKIIdx: number;
  if (priorFirstKeptEntryId === undefined) {
    priorFKIIdx = -1;
  } else {
    const idx = idToIdx.get(priorFirstKeptEntryId);
    if (idx === undefined) throw new Error(`priorFirstKeptEntryId "${priorFirstKeptEntryId}" not found`);
    priorFKIIdx = idx;
  }

  const result: ObservationEntryData[] = [];
  for (const entry of entries) {
    if (!isObservationEntry(entry)) continue;
    if (!isObservationEntryData(entry.data)) continue;
    const fromIdx = idToIdx.get(entry.data.coversFromId);
    if (fromIdx === undefined) continue;
    if (fromIdx >= priorFKIIdx && fromIdx < newFKIIdx) result.push(entry.data);
  }
  return result;
};
