import { describe, expect, it, vi } from "vitest";

import {
  captureSessionBranchFence,
  isSessionBranchFenceCurrent,
} from "../src/compaction-safety.js";
import { registerCompactionHook } from "../src/compaction-hook.js";
import { Runtime } from "../src/runtime.js";

describe("compaction session and branch safety", () => {
  it("detects session replacement or branch navigation during asynchronous work", () => {
    let sessionId = "session-a";
    let leafId = "leaf-a";
    const sessionManager = {
      getSessionId: () => sessionId,
      getLeafId: () => leafId,
    };
    const fence = captureSessionBranchFence(sessionManager);

    expect(isSessionBranchFenceCurrent(fence, sessionManager)).toBe(true);

    leafId = "leaf-b";
    expect(isSessionBranchFenceCurrent(fence, sessionManager)).toBe(false);

    leafId = "leaf-a";
    sessionId = "session-b";
    expect(isSessionBranchFenceCurrent(fence, sessionManager)).toBe(false);
  });

  it("returns control to Pi when default compaction override is disabled", async () => {
    let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
    const pi = {
      on: vi.fn((event: string, registered: typeof handler) => {
        if (event === "session_before_compact") handler = registered;
      }),
    };
    const runtime = new Runtime();
    runtime.loadedConfig = true;
    runtime.config.extension.overrideDefaultCompaction = false;
    const resolveModel = vi.spyOn(runtime, "resolveModel");

    registerCompactionHook(pi as never, runtime);
    const result = await handler?.({} as never, { cwd: "/project" } as never);

    expect(result).toBeUndefined();
    expect(resolveModel).not.toHaveBeenCalled();
    expect(runtime.compactHookInFlight).toBe(false);
  });

  it("exposes a distinct reset reason when durable catch-up invalidates the live epoch", () => {
    const runtime = new Runtime();

    runtime.observerEpoch.invalidate("catch-up-persisted");

    expect(runtime.observerEpoch.stats()).toMatchObject({
      active: false,
      lastResetReason: "catch-up-persisted",
    });
  });
});
