import { describe, expect, it, vi } from "vitest";

const cancelObserverMock = vi.hoisted(() => vi.fn());
const cancelReflectionMock = vi.hoisted(() => vi.fn());
const invalidateMock = vi.hoisted(() => vi.fn());

vi.mock("../src/runtime.js", () => ({
  Runtime: class {
    observerTask = { cancel: cancelObserverMock };
    reflectionTask = { cancel: cancelReflectionMock };
    cacheTelemetry = {};
    observerEpoch = { invalidate: invalidateMock };
    setPiSessionId = vi.fn();
  },
}));
vi.mock("../src/compaction-hook.js", () => ({ registerCompactionHook: vi.fn() }));
vi.mock("../src/observer-trigger.js", () => ({ registerObserverTrigger: vi.fn() }));
vi.mock("../src/auto-compaction.js", () => ({ registerAutoCompactionTrigger: vi.fn() }));
vi.mock("../src/status.js", () => ({ registerStatusCommand: vi.fn() }));
vi.mock("../src/memory.js", () => ({ registerMemoryCommand: vi.fn() }));
vi.mock("../src/tools/recall.js", () => ({ registerRecallTool: vi.fn() }));
vi.mock("../src/cache-telemetry.js", () => ({ registerCacheInfoCommand: vi.fn() }));

describe("extension memory task lifecycle adapters", () => {
  it("cancels active observer and reflection work before every branch or session departure", async () => {
    cancelObserverMock.mockReset();
    cancelReflectionMock.mockReset();
    invalidateMock.mockReset();
    const handlers = new Map<string, () => void>();
    const pi = {
      on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
    };
    const { default: extension } = await import("../src/index.js");

    extension(pi as never);
    handlers.get("session_before_switch")?.();
    handlers.get("session_before_fork")?.();
    handlers.get("session_before_tree")?.();
    handlers.get("session_shutdown")?.();

    const expectedCancellations = [
      ["session-switch"],
      ["session-fork"],
      ["tree-navigation"],
      ["session-shutdown"],
    ];
    expect(cancelObserverMock.mock.calls).toEqual(expectedCancellations);
    expect(cancelReflectionMock.mock.calls).toEqual(expectedCancellations);
    expect(invalidateMock.mock.calls).toEqual([
      ["session-change"],
      ["session-change"],
      ["session-change"],
      ["session-change"],
    ]);
  });
});
