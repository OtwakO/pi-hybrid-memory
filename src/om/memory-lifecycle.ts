import { createHash } from "node:crypto";

import type {
  MemoryLifecycleDetailsV5,
  MemoryLifecycleEventV6,
  MemoryReflection,
  ReflectionProgress,
  ObservationRecord,
  ObservationRetirement,
  ReflectionRecord,
  ReflectionSupersession,
} from "../types.js";

const reflectionRecords = (reflections: readonly MemoryReflection[]): ReflectionRecord[] =>
  reflections.filter((reflection): reflection is ReflectionRecord => typeof reflection !== "string");

const reflectionPayload = (reflection: MemoryReflection): unknown =>
  typeof reflection === "string"
    ? { kind: "legacy", content: reflection }
    : {
      kind: "record",
      id: reflection.id,
      content: reflection.content,
      supportingObservationIds: reflection.supportingObservationIds,
      legacy: reflection.legacy ?? false,
    };

const addedReflectionRecords = (
  previousReflections: readonly MemoryReflection[],
  currentReflections: readonly MemoryReflection[],
): ReflectionRecord[] => {
  const previousIds = new Set(reflectionRecords(previousReflections).map(reflection => reflection.id));
  return reflectionRecords(currentReflections)
    .filter(reflection => !previousIds.has(reflection.id))
    .map(reflection => ({
      ...reflection,
      supportingObservationIds: [...reflection.supportingObservationIds],
    }));
};

const stableMemoryFingerprint = (
  observations: readonly ObservationRecord[],
  reflections: readonly MemoryReflection[],
): string => createHash("sha256")
  .update(JSON.stringify({
    observations: observations.map(observation => ({
      id: observation.id,
      content: observation.content,
      timestamp: observation.timestamp,
      relevance: observation.relevance,
      sourceEntryIds: observation.sourceEntryIds ?? [],
    })),
    reflections: reflections.map(reflectionPayload),
  }))
  .digest("hex");

/** Create the one-time lifecycle record persisted with a successful compaction. */
export const createMemoryLifecycleDetails = (input: {
  parentMemoryCompactionId?: string;
  observations: readonly ObservationRecord[];
  previousReflections: readonly MemoryReflection[];
  currentReflections: readonly MemoryReflection[];
  retirements: readonly ObservationRetirement[];
  supersessions: readonly ReflectionSupersession[];
}): MemoryLifecycleDetailsV5 => {
  return {
    type: "observational-memory",
    version: 5,
    generation: {
      inputFingerprint: stableMemoryFingerprint(input.observations, input.previousReflections),
      ...(input.parentMemoryCompactionId
        ? { parentMemoryCompactionId: input.parentMemoryCompactionId }
        : {}),
    },
    reflectionsAdded: addedReflectionRecords(input.previousReflections, input.currentReflections),
    observationsRetired: input.retirements.map(retirement => structuredClone(retirement)),
    reflectionsSuperseded: input.supersessions.map(supersession => structuredClone(supersession)),
  };
};

/** Create one parent-linked lifecycle event for compaction details or a custom journal entry. */
export const createMemoryLifecycleEvent = (input: {
  parentLifecycleEntryId?: string;
  reflectionProgress?: ReflectionProgress;
  observations: readonly ObservationRecord[];
  previousReflections: readonly MemoryReflection[];
  currentReflections: readonly MemoryReflection[];
  retirements: readonly ObservationRetirement[];
  supersessions: readonly ReflectionSupersession[];
}): MemoryLifecycleEventV6 => ({
  type: "observational-memory",
  version: 6,
  generation: {
    inputFingerprint: stableMemoryFingerprint(input.observations, input.previousReflections),
    ...(input.parentLifecycleEntryId
      ? { parentLifecycleEntryId: input.parentLifecycleEntryId }
      : {}),
  },
  ...(input.reflectionProgress
    ? { reflectionProgress: structuredClone(input.reflectionProgress) }
    : {}),
  reflectionsAdded: addedReflectionRecords(input.previousReflections, input.currentReflections),
  observationsRetired: input.retirements.map(retirement => structuredClone(retirement)),
  reflectionsSuperseded: input.supersessions.map(supersession => structuredClone(supersession)),
});
