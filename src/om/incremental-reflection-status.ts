import type { BranchMemoryIndex } from "./branch-memory-index.js";
import { measureReflectionBacklog, planNextReflectionWindow } from "./reflection-processor-plan.js";
import { isObservationEntryData, OBSERVATION_CUSTOM_TYPE } from "../types.js";
import type { Entry } from "../types.js";

export interface IncrementalReflectionStatus {
  compatibleFrontierEntryId?: string;
  totalObservationEntries: number;
  consideredObservationEntries: number;
  remainingObservationEntries: number;
  activeBacklogObservationCount: number;
  activeBacklogTokens: number;
  nextWindow:
    | { kind: "none" }
    | { kind: "blocked"; observationEntryId: string; observationCount: number }
    | {
        kind: "work";
        targetObservationEntryId: string;
        observationEntryCount: number;
        focusObservationCount: number;
      };
}

export const buildIncrementalReflectionStatus = (input: {
  entries: readonly Entry[];
  index: BranchMemoryIndex;
  compatibilityVersion: string;
  focusObservationTokens: number;
}): IncrementalReflectionStatus => {
  const canonicalEntryIds = input.index.observationEntryIds();
  const observationEntries = input.entries.filter(entry =>
    entry.type === "custom"
    && entry.customType === OBSERVATION_CUSTOM_TYPE
    && canonicalEntryIds.has(entry.id)
    && isObservationEntryData(entry.data));
  const compatibleFrontierEntryId =
    input.index.reflectionProgress?.compatibilityVersion === input.compatibilityVersion
      ? input.index.reflectionProgress.consideredThroughObservationEntryId
      : undefined;
  const frontierIndex = compatibleFrontierEntryId
    ? observationEntries.findIndex(entry => entry.id === compatibleFrontierEntryId)
    : -1;
  const consideredObservationEntries = Math.max(0, frontierIndex + 1);
  const plan = planNextReflectionWindow(input);
  const backlog = measureReflectionBacklog(input);

  return {
    ...(compatibleFrontierEntryId ? { compatibleFrontierEntryId } : {}),
    totalObservationEntries: observationEntries.length,
    consideredObservationEntries,
    remainingObservationEntries: observationEntries.length - consideredObservationEntries,
    activeBacklogObservationCount: backlog.activeObservationCount,
    activeBacklogTokens: backlog.activeObservationTokens,
    nextWindow: plan.kind === "work"
      ? {
          kind: "work",
          targetObservationEntryId: plan.targetObservationEntryId,
          observationEntryCount: plan.observationEntryIds.length,
          focusObservationCount: plan.focusObservations.length,
        }
      : structuredClone(plan),
  };
};
