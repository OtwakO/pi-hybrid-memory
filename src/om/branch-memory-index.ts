import { areExactDuplicateObservations } from "./observation-retirement.js";
import type {
  Entry,
  MemoryReflection,
  ObservationRecord,
  ObservationRetirement,
  ReflectionProgress,
  ReflectionRecord,
  ReflectionSupersession,
} from "../types.js";
import {
  MEMORY_LIFECYCLE_CUSTOM_TYPE,
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

export type ReflectionLifecycle =
  | { state: "current" }
  | { state: "superseded"; supersession: ReflectionSupersession };

export type ObservationLifecycle =
  | { state: "active" }
  | { state: "retired"; retirement: ObservationRetirement };

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
  latestLifecycleEntryId?: string;
  reflectionProgress?: ReflectionProgress;
  observationById(id: string): ObservationRecord | undefined;
  observationLifecycle(id: string): ObservationLifecycle | undefined;
  activeObservationIds(): Set<string>;
  observationEntryIds(): Set<string>;
  reflectionById(id: string): ReflectionRecord | undefined;
  reflectionLifecycle(id: string): ReflectionLifecycle | undefined;
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

const isLifecycleEntry = (entry: Entry): boolean =>
  entry.type === "custom" && entry.customType === MEMORY_LIFECYCLE_CUSTOM_TYPE;

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
  const reflectionSupersessions = new Map<string, ReflectionSupersession>();
  const canonicalObservationIds = new Set<string>();
  const activeObservationOrder: string[] = [];
  const activeObservationIds = new Set<string>();
  const observationRetirements = new Map<string, ObservationRetirement>();
  const observationEntries: Array<{ entryId: string; entryIndex: number; coversFromIndex?: number; records: ObservationRecord[] }> = [];
  const observationEntryIndexes = new Map<string, number>();
  const issues: MemoryReplayIssue[] = [];

  let latestMemoryCompactionIndex = -1;
  let latestMemoryCompactionId: string | undefined;
  let latestLifecycleEntryId: string | undefined;
  let reflectionProgress: ReflectionProgress | undefined;
  let hasV6Lifecycle = false;
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
      observationEntries.push({ entryId: entry.id, entryIndex, records });
      observationEntryIndexes.set(entry.id, entryIndex);
      for (const observation of records) {
        canonicalObservationIds.add(observation.id);
        if (!observationHistory.has(observation.id)) observationHistory.set(observation.id, observation);
        if (!observationRetirements.has(observation.id) && !activeObservationIds.has(observation.id)) {
          activeObservationIds.add(observation.id);
          activeObservationOrder.push(observation.id);
        }
      }
      continue;
    }
    const lifecycleCustomEntry = isLifecycleEntry(entry);
    if (entry.type !== "compaction" && !lifecycleCustomEntry) continue;

    const rawDetails = lifecycleCustomEntry ? entry.data : entry.details;
    const details = readMemoryDetails(rawDetails);
    if (!details) {
      if (claimsMemoryDetailsVersion(rawDetails, 5) || claimsMemoryDetailsVersion(rawDetails, 6)) {
        issues.push({
          entryId: entry.id,
          reason: "invalid-lifecycle-batch",
          detail: "persisted lifecycle event failed structural validation",
        });
      }
      continue;
    }
    if (lifecycleCustomEntry && details.version !== 6) {
      issues.push({
        entryId: entry.id,
        reason: "invalid-lifecycle-batch",
        detail: "custom lifecycle entries require V6 event data",
      });
      continue;
    }

    if (details.version === 4) {
      if (hasV6Lifecycle) {
        issues.push({
          entryId: entry.id,
          reason: "invalid-lifecycle-parent",
          detail: "legacy memory details cannot replace an established V6 lifecycle sequence",
        });
        continue;
      }
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
      latestLifecycleEntryId = entry.id;
      legacyBaselineIndex = entryIndex;
      baselineObservations = details.observations.map(observation =>
        cloneObservation(observationHistory.get(observation.id) ?? observation));
      currentReflections = details.reflections.map(cloneReflection);
      observationRetirements.clear();
      reflectionSupersessions.clear();
      activeObservationIds.clear();
      activeObservationOrder.length = 0;
      for (const observation of baselineObservations) {
        if (!activeObservationIds.has(observation.id)) {
          activeObservationIds.add(observation.id);
          activeObservationOrder.push(observation.id);
        }
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

    if (details.version === 5 && hasV6Lifecycle) {
      issues.push({
        entryId: entry.id,
        reason: "invalid-lifecycle-parent",
        detail: "V5 memory details cannot replace an established V6 lifecycle sequence",
      });
      continue;
    }
    const receivedParent = details.version === 5
      ? details.generation.parentMemoryCompactionId
      : details.generation.parentLifecycleEntryId;
    const expectedParent = details.version === 5 ? latestMemoryCompactionId : latestLifecycleEntryId;
    if (receivedParent !== expectedParent) {
      issues.push({
        entryId: entry.id,
        reason: "invalid-lifecycle-parent",
        detail: `expected parent ${expectedParent ?? "<root>"}, received ${receivedParent ?? "<root>"}`,
      });
      continue;
    }
    const nextProgress = details.version === 6 ? details.reflectionProgress : undefined;
    const nextProgressIndex = nextProgress
      ? observationEntryIndexes.get(nextProgress.consideredThroughObservationEntryId)
      : undefined;
    const currentProgressIndex = reflectionProgress
      ? observationEntryIndexes.get(reflectionProgress.consideredThroughObservationEntryId)
      : undefined;
    const validProgress = !nextProgress
      || (nextProgressIndex !== undefined
        && (reflectionProgress?.compatibilityVersion !== nextProgress.compatibilityVersion
          || currentProgressIndex === undefined
          || nextProgressIndex >= currentProgressIndex));
    const additions = details.reflectionsAdded.map(
      reflection => cloneReflection(reflection) as ReflectionRecord,
    );
    const retirements = details.observationsRetired.map(retirement => structuredClone(retirement));
    const supersessions = details.reflectionsSuperseded.map(supersession => structuredClone(supersession));
    const batchIds = new Set<string>();
    const retirementTargetIds = new Set(retirements.map(retirement => retirement.observationId));
    const validAdditions = additions.every(reflection => {
      if (batchIds.has(reflection.id) || reflectionHistory.has(reflection.id)) return false;
      batchIds.add(reflection.id);
      return reflection.supportingObservationIds.every(id => observationHistory.has(id));
    });
    const validRetirements = retirementTargetIds.size === retirements.length && retirements.every(retirement => {
      const observation = observationHistory.get(retirement.observationId);
      const preservingId = retirement.preservedByObservationIds[0];
      const preserving = observationHistory.get(preservingId);
      if (
        !observation
        || !preserving
        || retirement.observationId === preservingId
        || observationRetirements.has(retirement.observationId)
        || observationRetirements.has(preservingId)
        || retirementTargetIds.has(preservingId)
        || !canonicalObservationIds.has(retirement.observationId)
        || !activeObservationOrder.includes(retirement.observationId)
        || !activeObservationOrder.includes(preservingId)
        || !areExactDuplicateObservations(observation, preserving)
      ) return false;
      if (activeObservationOrder.indexOf(preservingId) >= activeObservationOrder.indexOf(retirement.observationId)) return false;
      return true;
    });
    const supersededIds = new Set<string>();
    const successorIds = new Set<string>();
    const additionsById = new Map(additions.map(reflection => [reflection.id, reflection]));
    const validSupersessions = supersessions.every(supersession => {
      const predecessor = reflectionHistory.get(supersession.reflectionId);
      const successor = additionsById.get(supersession.supersededByReflectionId);
      if (
        !predecessor
        || !successor
        || supersession.reflectionId === supersession.supersededByReflectionId
        || reflectionSupersessions.has(supersession.reflectionId)
        || supersededIds.has(supersession.reflectionId)
        || successorIds.has(supersession.supersededByReflectionId)
        || predecessor.content.trim().replace(/\s+/g, " ") !== successor.content.trim().replace(/\s+/g, " ")
        || predecessor.supportingObservationIds.some(id => !successor.supportingObservationIds.includes(id))
        || successor.supportingObservationIds.length <= predecessor.supportingObservationIds.length
      ) return false;
      supersededIds.add(supersession.reflectionId);
      successorIds.add(supersession.supersededByReflectionId);
      return true;
    });
    const validBatch = validProgress && validAdditions && validRetirements && validSupersessions;
    if (!validBatch) {
      issues.push({
        entryId: entry.id,
        reason: "invalid-lifecycle-batch",
        detail: "lifecycle additions or retirements violate immutable ids, provenance, or preservation rules",
      });
      continue;
    }

    if (entry.type === "compaction") {
      latestMemoryCompactionIndex = entryIndex;
      latestMemoryCompactionId = entry.id;
    }
    latestLifecycleEntryId = entry.id;
    if (details.version === 6) {
      hasV6Lifecycle = true;
      if (nextProgress) reflectionProgress = structuredClone(nextProgress);
    }
    for (const reflection of additions) {
      reflectionHistory.set(reflection.id, reflection);
      currentReflections.push(reflection);
    }
    for (const retirement of retirements) {
      observationRetirements.set(retirement.observationId, retirement);
      activeObservationIds.delete(retirement.observationId);
      const activeIndex = activeObservationOrder.indexOf(retirement.observationId);
      if (activeIndex >= 0) activeObservationOrder.splice(activeIndex, 1);
    }
    for (const supersession of supersessions) {
      reflectionSupersessions.set(supersession.reflectionId, supersession);
      currentReflections = currentReflections.filter(reflection =>
        typeof reflection === "string" || reflection.id !== supersession.reflectionId);
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
    committedObs: [...committedById.values()]
      .filter(observation => !observationRetirements.has(observation.id))
      .map(cloneObservation),
    pendingObs: pendingObs.filter(observation => !observationRetirements.has(observation.id)),
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
    latestLifecycleEntryId,
    reflectionProgress: reflectionProgress ? structuredClone(reflectionProgress) : undefined,
    observationById,
    observationLifecycle: id => {
      if (!observationHistory.has(id)) return undefined;
      const retirement = observationRetirements.get(id);
      return retirement
        ? { state: "retired", retirement: structuredClone(retirement) }
        : { state: "active" };
    },
    activeObservationIds: () => new Set(activeObservationOrder),
    observationEntryIds: () => new Set(observationEntryIndexes.keys()),
    reflectionById,
    reflectionLifecycle: id => {
      if (!reflectionHistory.has(id)) return undefined;
      const supersession = reflectionSupersessions.get(id);
      return supersession
        ? { state: "superseded", supersession: structuredClone(supersession) }
        : { state: "current" };
    },
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
