import type { Entry } from "./types.js";

export interface SessionBranchIdentity {
  getSessionId(): string | undefined;
  getLeafId(): string | null | undefined;
}

export interface SessionBranchFence {
  sessionId?: string;
  leafId?: string | null;
}

export const captureSessionBranchFence = (
  sessionManager: SessionBranchIdentity,
): SessionBranchFence => ({
  sessionId: sessionManager.getSessionId(),
  leafId: sessionManager.getLeafId(),
});

export const isSessionBranchFenceCurrent = (
  fence: SessionBranchFence,
  sessionManager: SessionBranchIdentity,
): boolean =>
  fence.sessionId === sessionManager.getSessionId()
  && fence.leafId === sessionManager.getLeafId();

/**
 * Accept only the leaf movement caused by the awaited observer's own durable
 * observation appends. Any session change, missing original leaf, or unrelated
 * entry after that leaf is navigation and must cancel the stale compaction.
 */
export const advanceFenceAcrossObservationAppends = (
  fence: SessionBranchFence,
  sessionManager: SessionBranchIdentity,
  branch: readonly Entry[],
  observationCustomType: string,
): SessionBranchFence | null => {
  if (fence.sessionId !== sessionManager.getSessionId()) return null;
  if (fence.leafId === sessionManager.getLeafId()) return fence;
  if (!fence.leafId) return null;

  const originalLeafIndex = branch.findIndex((entry) => entry.id === fence.leafId);
  if (originalLeafIndex < 0) return null;
  const appended = branch.slice(originalLeafIndex + 1);
  if (
    appended.length === 0
    || appended.some((entry) => entry.type !== "custom" || entry.customType !== observationCustomType)
    || branch.at(-1)?.id !== sessionManager.getLeafId()
  ) {
    return null;
  }

  return captureSessionBranchFence(sessionManager);
};
