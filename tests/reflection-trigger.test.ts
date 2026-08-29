import { beforeEach, describe, expect, it, vi } from "vitest";

import { Runtime } from "../src/runtime.js";
import {
  incrementalReflectionCompatibilityVersion,
  startIncrementalReflection,
} from "../src/reflection-trigger.js";
import type { Entry } from "../src/types.js";

const processNextReflectionWindowMock = vi.hoisted(() => vi.fn());

vi.mock("../src/om/incremental-reflection-processor.js", () => ({
  processNextReflectionWindow: processNextReflectionWindowMock,
}));

describe("incremental reflection trigger", () => {
  beforeEach(() => {
    processNextReflectionWindowMock.mockReset();
  });

  const model = {
    provider: "test-provider",
    api: "openai-completions",
    id: "test-model",
    contextWindow: 100_000,
    maxTokens: 8_000,
  };

  const context = (runtime: Runtime, entries: Entry[] = []) => ({
    hasUI: false,
    ui: { notify: vi.fn() },
    model: model as never,
    modelRegistry: { find: vi.fn(), complete: vi.fn() },
    sessionManager: {
      getSessionId: () => "session-a",
      getLeafId: () => "leaf-a",
      getBranch: () => entries,
    },
  });

  it("starts one bounded processor transaction with the configured model policy", async () => {
    const runtime = new Runtime();
    runtime.piSessionId = "session-a";
    runtime.config.hybrid.maxSummaryTokens = 12_000;
    runtime.config.hybrid.reflectionThresholdTokens = 3_000;
    const entries: Entry[] = [];
    const ctx = context(runtime, entries);
    processNextReflectionWindowMock.mockResolvedValueOnce({ outcome: "no-work" });
    const appendEntry = vi.fn();

    startIncrementalReflection(appendEntry, runtime, ctx);
    await runtime.reflectionTask.promise;

    expect(processNextReflectionWindowMock).toHaveBeenCalledOnce();
    expect(processNextReflectionWindowMock).toHaveBeenCalledWith(expect.objectContaining({
      session: ctx.sessionManager,
      appendEntry,
      compatibilityVersion: incrementalReflectionCompatibilityVersion(model as never),
      focusObservationTokens: 12_000,
      foldInput: expect.objectContaining({
        params: expect.objectContaining({
          model,
          signal: expect.any(AbortSignal),
          cacheOptions: expect.any(Object),
        }),
        contextBudgets: expect.objectContaining({ focusObservationTokens: 12_000 }),
        reflectionThresholdTokens: 3_000,
        targetSummaryTokens: 12_000,
      }),
    }));
  });

  it("does not immediately retry a failed frontier when progress was coalesced", async () => {
    const runtime = new Runtime();
    runtime.piSessionId = "session-a";
    const ctx = context(runtime);
    let release!: () => void;
    processNextReflectionWindowMock.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ outcome: "failed", reason: "timeout" });
    }));
    const appendEntry = vi.fn();

    startIncrementalReflection(appendEntry, runtime, ctx);
    startIncrementalReflection(appendEntry, runtime, ctx);
    release();
    await runtime.reflectionTask.promise;
    await Promise.resolve();

    expect(processNextReflectionWindowMock).toHaveBeenCalledTimes(1);
    expect(runtime.reflectionTask.active).toBe(false);
  });
});
