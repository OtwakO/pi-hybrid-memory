import { describe, expect, it, vi } from "vitest";

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
  it("starts one bounded processor transaction with the configured model policy", async () => {
    const model = {
      provider: "test-provider",
      api: "openai-completions",
      id: "test-model",
      contextWindow: 100_000,
      maxTokens: 8_000,
    };
    const runtime = new Runtime();
    runtime.piSessionId = "session-a";
    runtime.config.hybrid.maxSummaryTokens = 12_000;
    runtime.config.hybrid.reflectionThresholdTokens = 3_000;
    const entries: Entry[] = [];
    const sessionManager = {
      getSessionId: () => "session-a",
      getLeafId: () => "leaf-a",
      getBranch: () => entries,
    };
    processNextReflectionWindowMock.mockResolvedValueOnce({ outcome: "no-work" });
    const appendEntry = vi.fn();

    startIncrementalReflection(appendEntry, runtime, {
      hasUI: false,
      ui: { notify: vi.fn() },
      model: model as never,
      modelRegistry: { find: vi.fn(), complete: vi.fn() },
      sessionManager,
    });
    await runtime.reflectionTask.promise;

    expect(processNextReflectionWindowMock).toHaveBeenCalledOnce();
    expect(processNextReflectionWindowMock).toHaveBeenCalledWith(expect.objectContaining({
      session: sessionManager,
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
});
