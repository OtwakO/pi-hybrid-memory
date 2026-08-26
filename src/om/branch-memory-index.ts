import type {
  Entry,
  MemoryReflection,
  ObservationRecord,
  ReflectionRecord,
} from "../types.js";
import {
  OBSERVATION_CUSTOM_TYPE,
  claimsMemoryDetailsVersion,
  isObservationEntryData,
  readMemoryDetails,
} from "../types.js";
import { resolveKeptBoundaryIndex } from "./branch.js";

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

export interface MemoryReplayIssue {
  entryId: string;
  reason: "conflicting-observation" | "invalid-lifecycle-parent" | "invalid-lifecycle-batch";
  detail: string;
}

export interface BranchMemoryIndex {
  current: CurrentBranchMemory;
  compactions: Entry[];
  issues: MemoryReplayIssue[];
  latestMemoryCompactionId?: string;
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

const observationPayload = (observation: ObservationRecord): string => JSON.stringify({
  id: observation.id,
  content: observation.content,
  timestamp: observation.timestamp,
  relevance: observation.relevance,
  sourceEntryIds: observation.sourceEntryIds ?? [],
});

const sameObservation = (left: ObservationRecord, right: ObservationRecord): boolean =>
  observationPayload(left) === observationPayload(right);

/** Build the authoritative read projection for one active Pi branch. */
export const buildBranchMemoryIndex = (
  entries: Entry[],
  options: BranchMemoryIndexOptions = {},
): BranchMemoryIndex => {
  const entryIndexes = new Map<string, number>();
  const branchEntries = new Map<string, Entry>();
  const compactions: Entry[] = [];
  const observationHistory = new Map<string, ObservationRecord>();
  const reflectionHistory = new Map<string, ReflectionRecord>();
  const observationEntries: Array<{ entryIndex: number; coversFromIndex?: number; records: ObservationRecord[] }> = [];
  const issues: MemoryReplayIssue[] = [];

  let latestMemoryCompactionIndex = -1;
  let latestMemoryCompactionId: string | undefined;
  let legacyBaselineIndex = -1;
  let baselineObservations: ObservationRecord[] = [];
  let currentReflections: MemoryReflection[] = [];

  for (const [entryIndex, entry] of entries.entries()) {
    entryIndexes.set(entry.id, entryIndex);
    branchEntries.set(entry.id, entry);
    if (entry.type === "compaction") compactions.push(entry);

    if (isObservationEntry(entry) && isObservationEntryData(entry.data)) {
      const records = entry.data.records.map(cloneObservation);
      const batch = new Map<string, ObservationRecord>();
      const conflict = records.find(observation => {
        const existing = batch.get(observation.id) ?? observationHistory.get(observation.id);
        if (!existing) {
          batch.set(observation.id, observation);
          return false;
        }
        return !sameObservation(existing, observation);
      });
      if (conflict) {
        issues.push({
          entryId: entry.id,
          reason: "conflicting-observation",
          detail: `observation ${conflict.id} reuses an existing id with different immutable evidence`,
        });
        continue;
      }
      observationEntries.push({ entryIndex, records });
      for (const observation of records) {
        if (!observationHistory.has(observation.id)) observationHistory.set(observation.id, observation);
      }
      continue;
    }
    if (entry.type !== "compaction") continue;

    const details = readMemoryDetails(entry.details);
    if (!details) {
      if (claimsMemoryDetailsVersion(entry.details, 5)) {
        issues.push({
          entryId: entry.id,
          reason: "invalid-lifecycle-batch",
          detail: "persisted V5 lifecycle details failed structural validation",
        });
      }
      continue;
    }

    if (details.version === 4) {
      const baselineBatch = new Map<string, ObservationRecord>();
      const conflict = details.observations.find(observation => {
        const existing = baselineBatch.get(observation.id) ?? observationHistory.get(observation.id);
        if (!existing) {
          baselineBatch.set(observation.id, observation);
          return false;
        }
        return !sameObservation(existing, observation);
      });
      if (conflict) {
        issues.push({
          entryId: entry.id,
          reason: "conflicting-observation",
          detail: `legacy snapshot observation ${conflict.id} conflicts with canonical immutable evidence`,
        });
        continue;
      }

      latestMemoryCompactionIndex = entryIndex;
      latestMemoryCompactionId = entry.id;
      legacyBaselineIndex = entryIndex;
      baselineObservations = details.observations.map(observation =>
        cloneObservation(observationHistory.get(observation.id) ?? observation));
      currentReflections = details.reflections.map(cloneReflection);
      for (const observation of baselineObservations) {
        if (!observationHistory.has(observation.id)) {
          observationHistory.set(observation.id, cloneObservation(observation));
        }
      }
      for (const reflection of details.reflections) {
        if (typeof reflection !== "string") {
          reflectionHistory.set(reflection.id, cloneReflection(reflection) as ReflectionRecord);
        }
      }
      continue;
    }

    if (details.generation.parentMemoryCompactionId !== latestMemoryCompactionId) {
      issues.push({
        entryId: entry.id,
        reason: "invalid-lifecycle-parent",
        detail: `expected parent ${latestMemoryCompactionId ?? "<root>"}, received ${details.generation.parentMemoryCompactionId ?? "<root>"}`,
      });
      continue;
    }
    const additions = details.reflectionsAdded.map(
      reflection => cloneReflection(reflection) as ReflectionRecord,
    );
    const batchIds = new Set<string>();
    const validBatch = additions.every(reflection => {
      if (batchIds.has(reflection.id) || reflectionHistory.has(reflection.id)) return false;
      batchIds.add(reflection.id);
      return reflection.supportingObservationIds.every(id => observationHistory.has(id));
    });
    if (!validBatch) {
      issues.push({
        entryId: entry.id,
        reason: "invalid-lifecycle-batch",
        detail: "reflection additions contain a duplicate id or unknown supporting observation id",
      });
      continue;
    }

    latestMemoryCompactionIndex = entryIndex;
    latestMemoryCompactionId = entry.id;
    for (const reflection of additions) {
      reflectionHistory.set(reflection.id, reflection);
      currentReflections.push(reflection);
    }
  }

  for (const item of observationEntries) {
    const entry = entries[item.entryIndex];
    if (!isObservationEntryData(entry.data)) continue;
    item.coversFromIndex = entryIndexes.get(entry.data.coversFromId);
  }

  const pendingStartIndex = latestMemoryCompactionIndex === -1
    ? 0
    : resolveKeptBoundaryIndex(entries, latestMemoryCompactionIndex, options.onBoundaryRecovery);
  const committedById = new Map(baselineObservations.map(observation => [observation.id, observation]));
  const pendingObs: ObservationRecord[] = [];

  for (const item of observationEntries) {
    if (item.entryIndex <= legacyBaselineIndex) continue;
    const pending = item.coversFromIndex !== undefined && item.coversFromIndex >= pendingStartIndex;
    for (const observation of item.records) {
      if (pending) pendingObs.push(cloneObservation(observation));
      else committedById.set(observation.id, cloneObservation(observation));
    }
  }

  const current: CurrentBranchMemory = {
    reflections: currentReflections.map(cloneReflection),
    committedObs: [...committedById.values()].map(cloneObservation),
    pendingObs,
  };

  const observationById = (id: string): ObservationRecord | undefined => {
    const observation = observationHistory.get(id);
    return observation ? cloneObservation(observation) : undefined;
  };

  const reflectionById = (id: string): ReflectionRecord | undefined => {
    const reflection = reflectionHistory.get(id);
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
    issues: issues.map(issue => ({ ...issue })),
    latestMemoryCompactionId,
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
