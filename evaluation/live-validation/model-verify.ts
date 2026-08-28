import { buildBranchMemoryIndex } from "../../src/om/branch-memory-index.js";
import {
  MEMORY_LIFECYCLE_CUSTOM_TYPE,
  readMemoryDetails,
} from "../../src/types.js";
import { BASELINE_OBSERVATION_ID, MODEL_MARKER, MODEL_PATH, MODEL_VALUE } from "./model-fixture.js";
import { readSessionEntries } from "./verify.js";

export interface ModelVerification {
  observationId: string;
  reflectionIds: string[];
  observationContent: string;
  sourceEntryIds: string[];
  incrementalLifecycleEntryId: string;
  compactionId: string;
}

const preservesExactFixture = (content: string): boolean =>
  content.includes(MODEL_MARKER)
  && content.includes(MODEL_PATH)
  && content.includes(MODEL_VALUE)
  && /revok|until.*user|explicit/i.test(content);

export const verifyIncrementalReflectionBeforeCompaction = async (
  sessionFile: string,
  durableSourceId: string,
): Promise<Omit<ModelVerification, "compactionId">> => {
  const entries = await readSessionEntries(sessionFile);
  const index = buildBranchMemoryIndex(entries);
  if (index.issues.length > 0) {
    throw new Error(`Lifecycle replay issues before compaction: ${index.issues.map(issue => issue.detail).join("; ")}`);
  }
  const compactions = entries.filter(entry => entry.type === "compaction");
  if (compactions.length !== 1) {
    throw new Error(`Expected only the seeded V4 compaction before incremental reflection verification; received ${compactions.length}.`);
  }
  const lifecycleEntries = entries.filter(entry =>
    entry.type === "custom" && entry.customType === MEMORY_LIFECYCLE_CUSTOM_TYPE);
  if (lifecycleEntries.length !== 1) {
    throw new Error(`Expected one incremental V6 lifecycle entry before compaction; received ${lifecycleEntries.length}.`);
  }
  const lifecycleEntry = lifecycleEntries[0];
  const details = readMemoryDetails(lifecycleEntry.data);
  if (!details || details.version !== 6) {
    throw new Error("Incremental reflection did not persist valid V6 custom-entry data.");
  }
  if (!details.reflectionProgress) {
    throw new Error("Incremental reflection did not advance a compatible observation-entry frontier.");
  }
  if (details.observationsRetired.length > 0) {
    throw new Error("Model-assisted trial persisted an unexpected retirement.");
  }
  if (details.reflectionsAdded.length === 0) {
    throw new Error("Incremental reflector persisted no new reflection.");
  }

  const candidates = [...index.current.committedObs, ...index.current.pendingObs]
    .filter(observation => observation.id !== BASELINE_OBSERVATION_ID)
    .filter(observation => preservesExactFixture(observation.content));
  if (candidates.length === 0) throw new Error("Observer did not preserve all exact held-out fixture details.");
  const observation = candidates[0];
  const sourceEntryIds = observation.sourceEntryIds ?? [];
  if (!sourceEntryIds.includes(durableSourceId)) {
    throw new Error("Observer output does not cite the durable source entry.");
  }
  const sources = index.sourcesForObservation(observation.id);
  if (sources.missingIds.length > 0 || sources.entries.length === 0) {
    throw new Error("Observed fact provenance is unavailable after replay.");
  }
  const reflectionIds = details.reflectionsAdded
    .filter(reflection => reflection.supportingObservationIds.includes(observation.id))
    .map(reflection => reflection.id);
  if (reflectionIds.length === 0) {
    throw new Error("No incremental reflection supports the held-out observation.");
  }

  return {
    observationId: observation.id,
    reflectionIds,
    observationContent: observation.content,
    sourceEntryIds: [...sourceEntryIds],
    incrementalLifecycleEntryId: lifecycleEntry.id,
  };
};

export const verifyModelAssistedCompaction = async (
  sessionFile: string,
  expected: Omit<ModelVerification, "compactionId">,
): Promise<ModelVerification> => {
  const entries = await readSessionEntries(sessionFile);
  const index = buildBranchMemoryIndex(entries);
  if (index.issues.length > 0) throw new Error(`Lifecycle replay issues: ${index.issues.map(issue => issue.detail).join("; ")}`);
  const compactions = entries.filter(entry => entry.type === "compaction");
  if (compactions.length !== 2) throw new Error(`Expected seeded V4 plus one model-assisted compaction; received ${compactions.length}.`);
  const compaction = compactions[1];
  const details = readMemoryDetails(compaction.details);
  if (!details || details.version !== 6) throw new Error("Model-assisted compaction did not persist valid V6 details.");
  if (details.generation.parentLifecycleEntryId !== expected.incrementalLifecycleEntryId) {
    throw new Error("Compaction did not parent to the incremental lifecycle entry.");
  }
  if (details.reflectionsAdded.length > 0) {
    throw new Error("Covered compaction unexpectedly created a new reflection.");
  }
  const persistedReflectionIds = new Set(index.current.reflections
    .filter(reflection => typeof reflection !== "string")
    .map(reflection => reflection.id));
  if (expected.reflectionIds.some(id => !persistedReflectionIds.has(id))) {
    throw new Error("Incremental reflection is missing after compaction replay.");
  }

  return { ...expected, compactionId: compaction.id };
};
