import { buildBranchMemoryIndex } from "./branch-memory-index.js";
import type { BranchMemoryIndex } from "./branch-memory-index.js";
import { createMemoryLifecycleEvent } from "./memory-lifecycle.js";
import { MEMORY_LIFECYCLE_CUSTOM_TYPE } from "../types.js";
import type {
  Entry,
  MemoryReflection,
  ObservationRecord,
  ObservationRetirement,
  ReflectionProgress,
  ReflectionSupersession,
} from "../types.js";

interface LifecycleAppendSession {
  getSessionId(): string | undefined;
  getLeafId(): string | null | undefined;
  getBranch(): Entry[];
}

export interface LifecycleAppendFence {
  sessionId?: string;
  originLeafId?: string | null;
  parentLifecycleEntryId?: string;
}

export type LifecycleAppendResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "session-changed"
        | "branch-changed"
        | "lifecycle-advanced"
        | "invalid-lifecycle-event";
    };

export const captureLifecycleAppendFence = (
  session: LifecycleAppendSession,
  index: BranchMemoryIndex,
): LifecycleAppendFence => ({
  sessionId: session.getSessionId(),
  originLeafId: session.getLeafId(),
  parentLifecycleEntryId: index.latestLifecycleEntryId,
});

export const appendIncrementalLifecycle = (input: {
  session: LifecycleAppendSession;
  appendEntry(customType: string, data: unknown): void;
  fence: LifecycleAppendFence;
  reflectionProgress: ReflectionProgress;
  observations: readonly ObservationRecord[];
  previousReflections: readonly MemoryReflection[];
  currentReflections: readonly MemoryReflection[];
  retirements: readonly ObservationRetirement[];
  supersessions: readonly ReflectionSupersession[];
}): LifecycleAppendResult => {
  if (input.session.getSessionId() !== input.fence.sessionId) {
    return { ok: false, reason: "session-changed" };
  }

  const entries = input.session.getBranch();
  if (
    input.session.getLeafId() !== input.fence.originLeafId
    || !input.fence.originLeafId
    || !entries.some(entry => entry.id === input.fence.originLeafId)
  ) {
    return { ok: false, reason: "branch-changed" };
  }

  const index = buildBranchMemoryIndex(entries);
  if (index.latestLifecycleEntryId !== input.fence.parentLifecycleEntryId) {
    return { ok: false, reason: "lifecycle-advanced" };
  }

  const event = createMemoryLifecycleEvent({
    parentLifecycleEntryId: input.fence.parentLifecycleEntryId,
    reflectionProgress: input.reflectionProgress,
    observations: input.observations,
    previousReflections: input.previousReflections,
    currentReflections: input.currentReflections,
    retirements: input.retirements,
    supersessions: input.supersessions,
  });
  const syntheticEntry: Entry = {
    type: "custom",
    id: "synthetic-lifecycle-candidate",
    customType: MEMORY_LIFECYCLE_CUSTOM_TYPE,
    data: event,
  };
  const validated = buildBranchMemoryIndex([...entries, syntheticEntry]);
  if (
    validated.latestLifecycleEntryId !== syntheticEntry.id
    || validated.issues.length !== index.issues.length
  ) {
    return { ok: false, reason: "invalid-lifecycle-event" };
  }

  input.appendEntry(MEMORY_LIFECYCLE_CUSTOM_TYPE, event);
  return { ok: true };
};
