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
