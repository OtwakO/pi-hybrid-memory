import { planReflectionContext } from "./reflection-context-plan.js";
import { isObservationEntryData, OBSERVATION_CUSTOM_TYPE } from "../types.js";
import { estimateStringTokens } from "./tokens.js";
import type { BranchMemoryIndex } from "./branch-memory-index.js";
import type { Entry, ObservationEntryData, ObservationRecord } from "../types.js";

export interface ReflectionBacklog {
  observationEntryCount: number;
  activeObservationCount: number;
  activeObservationTokens: number;
}

export type ReflectionProcessorPlan =
  | { kind: "none" }
  | {
      kind: "blocked";
      observationEntryId: string;
      observationCount: number;
    }
  | {
      kind: "work";
      targetObservationEntryId: string;
      observationEntryIds: string[];
      focusObservations: ObservationRecord[];
    };

type CanonicalObservationEntry = Entry & { data: ObservationEntryData };

interface ReflectionBacklogSelection {
  entries: CanonicalObservationEntry[];
  activeObservationIds: ReadonlySet<string>;
}

const selectReflectionBacklog = (input: {
  entries: readonly Entry[];
  index: BranchMemoryIndex;
  compatibilityVersion: string;
}): ReflectionBacklogSelection => {
  const activeObservationIds = input.index.activeObservationIds();
  const canonicalEntryIds = input.index.observationEntryIds();
  const observationEntries = input.entries.filter((entry): entry is CanonicalObservationEntry =>
    entry.type === "custom"
    && entry.customType === OBSERVATION_CUSTOM_TYPE
    && canonicalEntryIds.has(entry.id)
    && isObservationEntryData(entry.data));
  const compatibleFrontier = input.index.reflectionProgress?.compatibilityVersion === input.compatibilityVersion
    ? input.index.reflectionProgress.consideredThroughObservationEntryId
    : undefined;
  const frontierIndex = compatibleFrontier
    ? observationEntries.findIndex(entry => entry.id === compatibleFrontier)
    : -1;
  return {
    entries: observationEntries.slice(frontierIndex + 1),
    activeObservationIds,
  };
};

export const measureReflectionBacklog = (input: {
  entries: readonly Entry[];
  index: BranchMemoryIndex;
  compatibilityVersion: string;
}): ReflectionBacklog => {
  const backlog = selectReflectionBacklog(input);
  const activeObservations = backlog.entries.flatMap(entry =>
    entry.data.records.filter(record => backlog.activeObservationIds.has(record.id)));
  return {
    observationEntryCount: backlog.entries.length,
    activeObservationCount: activeObservations.length,
    activeObservationTokens: activeObservations.reduce(
      (sum, observation) => sum + estimateStringTokens(observation.content),
      0,
    ),
  };
};

export const planNextReflectionWindow = (input: {
  entries: readonly Entry[];
  index: BranchMemoryIndex;
  compatibilityVersion: string;
  focusObservationTokens: number;
}): ReflectionProcessorPlan => {
  const backlog = selectReflectionBacklog(input);
  const candidates = backlog.entries;
  const activeObservationIds = backlog.activeObservationIds;
  if (candidates.length === 0) return { kind: "none" };

  const selectedEntryIds: string[] = [];
  const selectedObservations: ObservationRecord[] = [];
  for (const entry of candidates) {
    if (!isObservationEntryData(entry.data)) continue;
    const activeRecords = entry.data.records.filter(record => activeObservationIds.has(record.id));
    const proposed = [...selectedObservations, ...activeRecords];
    const context = planReflectionContext({
      reflections: [],
      focusObservations: proposed,
      historicalObservations: [],
      budgets: {
        reflectionTokens: 0,
        focusObservationTokens: input.focusObservationTokens,
        protectedObservationTokens: 0,
        recentObservationTokens: 0,
      },
    });
    if (context.focusOverflow) {
      if (selectedEntryIds.length === 0) {
        return {
          kind: "blocked",
          observationEntryId: entry.id,
          observationCount: activeRecords.length,
        };
      }
      break;
    }
    selectedEntryIds.push(entry.id);
    selectedObservations.push(...activeRecords);
  }

  if (selectedEntryIds.length === 0) return { kind: "none" };
  return {
    kind: "work",
    targetObservationEntryId: selectedEntryIds.at(-1)!,
    observationEntryIds: selectedEntryIds,
    focusObservations: structuredClone(selectedObservations),
  };
};
