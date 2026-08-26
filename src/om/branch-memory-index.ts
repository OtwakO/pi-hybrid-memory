import type {
  Entry,
  MemoryReflection,
  ObservationRecord,
  ReflectionRecord,
} from "../types.js";
import {
  OBSERVATION_CUSTOM_TYPE,
  isObservationEntryData,
  readMemoryDetails,
} from "../types.js";
import {
  findLastCompactionIndex,
  resolveKeptBoundaryIndex,
} from "./branch.js";

export interface CurrentBranchMemory {
  reflections: MemoryReflection[];
  committedObs: ObservationRecord[];
  pendingObs: ObservationRecord[];
}

export interface ObservationSources {
  entries: Entry[];
  missingIds: string[];
}

export interface ReflectionEvidence extends ObservationSources {
  observations: ObservationRecord[];
  missingObservationIds: string[];
}

export interface BranchMemoryIndex {
  current: CurrentBranchMemory;
  compactions: Entry[];
  observationById(id: string): ObservationRecord | undefined;
  reflectionById(id: string): ReflectionRecord | undefined;
  sourceEntryById(id: string): Entry | undefined;
  sourcesForObservation(id: string): ObservationSources;
  evidenceForReflection(id: string): ReflectionEvidence;
}

export interface BranchMemoryIndexOptions {
  onBoundaryRecovery?: (firstKeptEntryId: string) => void;
}

const cloneObservation = (observation: ObservationRecord): ObservationRecord => ({
  ...observation,
  sourceEntryIds: observation.sourceEntryIds ? [...observation.sourceEntryIds] : undefined,
});

const cloneReflection = (reflection: MemoryReflection): MemoryReflection =>
  typeof reflection === "string"
    ? reflection
    : { ...reflection, supportingObservationIds: [...reflection.supportingObservationIds] };

const isObservationEntry = (entry: Entry): boolean =>
  entry.type === "custom" && entry.customType === OBSERVATION_CUSTOM_TYPE;

/**
 * Build the authoritative read projection for one active Pi branch.
 *
 * Current memory is resolved eagerly because observer, compaction, status, and
 * UI use it routinely. Historical ID maps are built lazily on first recall so
 * normal turns do not repeatedly parse every prior compaction.
 */
export const buildBranchMemoryIndex = (
  entries: Entry[],
  options: BranchMemoryIndexOptions = {},
): BranchMemoryIndex => {
  const entryIndexes = new Map<string, number>();
  const branchEntries = new Map<string, Entry>();
  const compactions: Entry[] = [];

  for (const [entryIndex, entry] of entries.entries()) {
    entryIndexes.set(entry.id, entryIndex);
    branchEntries.set(entry.id, entry);
    if (entry.type === "compaction") compactions.push(entry);
  }

  const latestCompactionIndex = findLastCompactionIndex(entries);
  let memoryCompactionIndex = -1;
  let latestDetails: ReturnType<typeof readMemoryDetails> = undefined;
  for (let index = latestCompactionIndex; index >= 0 && !latestDetails; index--) {
    if (entries[index].type !== "compaction") continue;
    latestDetails = readMemoryDetails(entries[index].details);
    if (latestDetails) memoryCompactionIndex = index;
  }
  const pendingStartIndex = memoryCompactionIndex === -1
    ? 0
    : resolveKeptBoundaryIndex(entries, memoryCompactionIndex, options.onBoundaryRecovery);
  const pendingObs: ObservationRecord[] = [];

  for (const entry of entries) {
    if (!isObservationEntry(entry) || !isObservationEntryData(entry.data)) continue;
    const coversFromIndex = entryIndexes.get(entry.data.coversFromId);
    if (coversFromIndex !== undefined && coversFromIndex >= pendingStartIndex) {
      pendingObs.push(...entry.data.records.map(cloneObservation));
    }
  }

  const current: CurrentBranchMemory = {
    reflections: latestDetails?.reflections.map(cloneReflection) ?? [],
    committedObs: latestDetails?.observations.map(cloneObservation) ?? [],
    pendingObs,
  };

  let observationHistory: Map<string, ObservationRecord> | undefined;
  let reflectionHistory: Map<string, ReflectionRecord> | undefined;

  const ensureHistory = (): void => {
    if (observationHistory && reflectionHistory) return;
    observationHistory = new Map<string, ObservationRecord>();
    reflectionHistory = new Map<string, ReflectionRecord>();

    for (const entry of entries) {
      if (isObservationEntry(entry) && isObservationEntryData(entry.data)) {
        for (const observation of entry.data.records) {
          observationHistory.set(observation.id, cloneObservation(observation));
        }
      }
      if (entry.type !== "compaction") continue;

      const memoryDetails = readMemoryDetails(entry.details);
      if (!memoryDetails) continue;
      for (const observation of memoryDetails.observations) {
        observationHistory.set(observation.id, observation);
      }
      for (const reflection of memoryDetails.reflections) {
        if (typeof reflection !== "string") reflectionHistory.set(reflection.id, reflection);
      }
    }
  };

  const observationById = (id: string): ObservationRecord | undefined => {
    ensureHistory();
    const observation = observationHistory?.get(id);
    return observation ? cloneObservation(observation) : undefined;
  };

  const reflectionById = (id: string): ReflectionRecord | undefined => {
    ensureHistory();
    const reflection = reflectionHistory?.get(id);
    return reflection ? cloneReflection(reflection) as ReflectionRecord : undefined;
  };

  const sourcesForObservation = (id: string): ObservationSources => {
    const observation = observationById(id);
    const matched: Entry[] = [];
    const missingIds: string[] = [];
    for (const sourceId of observation?.sourceEntryIds ?? []) {
      const entry = branchEntries.get(sourceId);
      if (entry) matched.push(entry);
      else missingIds.push(sourceId);
    }
    return { entries: matched, missingIds };
  };

  return {
    current,
    compactions: [...compactions],
    observationById,
    reflectionById,
    sourceEntryById: id => branchEntries.get(id),
    sourcesForObservation,
    evidenceForReflection: id => {
      const reflection = reflectionById(id);
      const supportingObservations: ObservationRecord[] = [];
      const sourceEntries: Entry[] = [];
      const missingObservationIds: string[] = [];
      const missingSourceIds: string[] = [];
      const seenSourceIds = new Set<string>();

      for (const observationId of reflection?.supportingObservationIds ?? []) {
        const observation = observationById(observationId);
        if (!observation) {
          missingObservationIds.push(observationId);
          continue;
        }
        supportingObservations.push(observation);
        const sources = sourcesForObservation(observationId);
        missingSourceIds.push(...sources.missingIds);
        for (const entry of sources.entries) {
          if (seenSourceIds.has(entry.id)) continue;
          seenSourceIds.add(entry.id);
          sourceEntries.push(entry);
        }
      }

      return {
        observations: supportingObservations,
        entries: sourceEntries,
        missingObservationIds,
        missingIds: missingSourceIds,
      };
    },
  };
};
