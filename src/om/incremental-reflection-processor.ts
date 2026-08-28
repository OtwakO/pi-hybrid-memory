import { buildBranchMemoryIndex } from "./branch-memory-index.js";
import {
  appendIncrementalLifecycle,
  captureLifecycleAppendFence,
} from "./memory-lifecycle-append.js";
import type { MemoryFoldInput, MemoryFoldResult } from "./memory-fold.js";
import { planNextReflectionWindow } from "./reflection-processor-plan.js";
import type { Entry } from "../types.js";

interface ReflectionProcessorSession {
  getSessionId(): string | undefined;
  getLeafId(): string | null | undefined;
  getBranch(): Entry[];
}

type FoldInputDefaults = Omit<
  MemoryFoldInput,
  "reflections" | "observations" | "focusObservations" | "canonicalObservationIds"
>;

export type IncrementalReflectionOutcome =
  | { outcome: "no-work" }
  | { outcome: "blocked"; observationEntryId: string; observationCount: number }
  | { outcome: "deferred"; reason: "below-threshold" }
  | { outcome: "failed"; reason: string }
  | {
      outcome: "stale";
      reason: "session-changed" | "branch-changed" | "lifecycle-advanced";
    }
  | {
      outcome: "persisted";
      targetObservationEntryId: string;
      foldOutcome: "empty-window" | "reflected" | "deliberate-empty" | "no-change";
    };

export const processNextReflectionWindow = async (input: {
  session: ReflectionProcessorSession;
  appendEntry(customType: string, data: unknown): void;
  compatibilityVersion: string;
  focusObservationTokens: number;
  fold(foldInput: MemoryFoldInput): Promise<MemoryFoldResult>;
  foldInput: FoldInputDefaults;
}): Promise<IncrementalReflectionOutcome> => {
  const entries = input.session.getBranch();
  const index = buildBranchMemoryIndex(entries);
  const plan = planNextReflectionWindow({
    entries,
    index,
    compatibilityVersion: input.compatibilityVersion,
    focusObservationTokens: input.focusObservationTokens,
  });
  if (plan.kind === "none") return { outcome: "no-work" };
  if (plan.kind === "blocked") {
    return {
      outcome: "blocked",
      observationEntryId: plan.observationEntryId,
      observationCount: plan.observationCount,
    };
  }

  const fence = captureLifecycleAppendFence(input.session, index);
  const observations = [...index.current.committedObs, ...index.current.pendingObs];
  let foldResult: MemoryFoldResult;
  let foldOutcome: "empty-window" | "reflected" | "deliberate-empty" | "no-change";
  if (plan.focusObservations.length === 0) {
    foldResult = {
      ok: true,
      outcome: "no-change",
      reflections: index.current.reflections,
      observations,
      retirements: [],
      supersessions: [],
    };
    foldOutcome = "empty-window";
  } else {
    foldResult = await input.fold({
      ...input.foldInput,
      reflections: index.current.reflections,
      observations,
      focusObservations: plan.focusObservations,
      canonicalObservationIds: index.activeObservationIds(),
    });
    if (!foldResult.ok) return { outcome: "failed", reason: foldResult.reason };
    if (foldResult.outcome === "below-threshold") {
      return { outcome: "deferred", reason: "below-threshold" };
    }
    foldOutcome = foldResult.outcome;
  }

  const append = appendIncrementalLifecycle({
    session: input.session,
    appendEntry: input.appendEntry,
    fence,
    reflectionProgress: {
      consideredThroughObservationEntryId: plan.targetObservationEntryId,
      compatibilityVersion: input.compatibilityVersion,
    },
    observations,
    previousReflections: index.current.reflections,
    currentReflections: foldResult.reflections,
    retirements: foldResult.retirements,
    supersessions: foldResult.supersessions,
  });
  if (!append.ok) {
    if (append.reason === "invalid-lifecycle-event") {
      return { outcome: "failed", reason: append.reason };
    }
    return { outcome: "stale", reason: append.reason };
  }

  return {
    outcome: "persisted",
    targetObservationEntryId: plan.targetObservationEntryId,
    foldOutcome,
  };
};
