// Branch utilities: entry indexing, memory state, observation coverage — ported from pi-observational-memory
import type {
  Entry,
  MemoryReflection,
  ObservationEntryData,
  ObservationRecord,
  SourceProgress,
} from "../types.js";
import { OBSERVATION_CUSTOM_TYPE, isObservationEntryData, readMemoryDetails } from "../types.js";
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

export interface ObservationCoverageAnchor {
  coveredSourceId?: string;
  coveredSourceIndex: number;
  sourceProgress?: SourceProgress;
}

export const resolveObservationCoverageAnchor = (entries: Entry[]): ObservationCoverageAnchor => {
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) idToIdx.set(entries[i].id, i);

  let coveredSourceIndex = -1;
  let coveredSourceId: string | undefined;
  let sourceProgress: SourceProgress | undefined;
  for (const entry of entries) {
    if (!isObservationEntry(entry) || !isObservationEntryData(entry.data)) continue;
    const candidateIndex = idToIdx.get(entry.data.coversUpToId);
    if (candidateIndex !== undefined && candidateIndex >= coveredSourceIndex) {
      coveredSourceIndex = candidateIndex;
      coveredSourceId = entry.data.coversUpToId;
      const progress = entry.data.sourceProgress;
      const nextSource = entries.slice(candidateIndex + 1).find(isSourceEntry);
      sourceProgress = progress
        && nextSource?.id === progress.sourceEntryId
        && progress.nextOffset > 0
        && progress.nextOffset < progress.totalLength
        ? progress
        : undefined;
    }
  }

  return { coveredSourceId, coveredSourceIndex, sourceProgress };
};

export const lastObservationCoverEndIdx = (entries: Entry[]): number =>
  resolveObservationCoverageAnchor(entries).coveredSourceIndex;

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

/**
 * Resolve the kept-boundary index of a compaction entry.
 *
 * Falls back to `compactionIdx + 1` when `firstKeptEntryId` is absent or cannot
 * be located in the branch — this is the documented Pi behaviour:
 *
 *   compaction.md: «falling back to the entry after the previous compaction
 *   if that kept entry cannot be found in the path.»
 *
 * The fallback is necessary on retrofit onto sessions predating this
 * extension: Pi's own default compaction may have written a CompactionEntry
 * whose `firstKeptEntryId` references an entry that was pruned by an even
 * earlier kept boundary (the entry is real but not present in this branch
 * view). Hard-throwing here would make every turn error out — instead we
 * recover and let the next compaction establish our own clean boundary.
 *
 * When recovery is exercised, `onRecover(firstKept)` fires once per call; the
 * calling layer (trigger / hook) debounces display via a Runtime flag so the
 * user sees exactly one notice per session. The data layer itself stays pure.
 */
export const resolveKeptBoundaryIndex = (
  entries: Entry[],
  compactionIdx: number,
  onRecover?: (firstKept: string) => void,
): number => {
  const firstKept = entries[compactionIdx].firstKeptEntryId;
  if (!firstKept) return compactionIdx + 1;
  const idx = entries.findIndex((e) => e.id === firstKept);
  if (idx === -1) {
    onRecover?.(firstKept);
    return compactionIdx + 1;
  }
  return idx;
};

const liveTailStartIndex = (entries: Entry[]): number => {
  const compactionIdx = findLastCompactionIndex(entries);
  if (compactionIdx === -1) return 0;
  return resolveKeptBoundaryIndex(entries, compactionIdx);
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


/**
 * Collect observation-carrying entries whose `coversFromId` falls in the
 * `[priorFKI, newFKI)` window — i.e. observations written during the span
 * covered by the compaction in progress.
 *
 * When the prior kept boundary (`priorFirstKeptEntryId`) cannot be found,
 * falls back to the compaction entry itself (`compactionIdx + 1`) instead of
 * throwing — see `resolveKeptBoundaryIndex` for the rationale.
 *
 * `onRecover` (optional) is the same debounced-by-caller seam used by
 * `getMemoryState`.
 */
export const collectObservationsByCoverage = (
  entries: Entry[],
  priorFirstKeptEntryId: string | undefined,
  newFirstKeptEntryId: string,
  onRecover?: (firstKept: string) => void,
): ObservationEntryData[] => {
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) idToIdx.set(entries[i].id, i);

  const newFKIIdx = idToIdx.get(newFirstKeptEntryId);
  if (newFKIIdx === undefined) return [];

  let priorFKIIdx: number;
  if (priorFirstKeptEntryId === undefined) {
    priorFKIIdx = -1;
  } else {
    const compactionIdx = findLastCompactionIndex(entries);
    if (compactionIdx < 0) {
      // Defensive: a prior boundary was passed but no compaction entry is
      // present. Unreachable from internal callers (they pass undefined
      // when findLastCompactionIndex returns -1). Broaden the window.
      onRecover?.(priorFirstKeptEntryId);
      priorFKIIdx = -1;
    } else {
      // The authoritative source for the prior boundary is the compaction
      // entry's own firstKeptEntryId. resolveKeptBoundaryIndex falls back to
      // compactionIdx + 1 if that entry is absent; otherwise it equals the
      // priorFirstKeptEntryId lookup the legacy code did directly.
      priorFKIIdx = resolveKeptBoundaryIndex(entries, compactionIdx, onRecover);
    }
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
