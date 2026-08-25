import { beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMessage } from "./fixtures/messages.js";

const runObserverMock = vi.hoisted(() => vi.fn());
const foldMemoryMock = vi.hoisted(() => vi.fn());
const mergePipelinesMock = vi.hoisted(() => vi.fn());

vi.mock("../src/om/observer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/om/observer.js")>();
  return { ...actual, runObserver: runObserverMock };
});

vi.mock("../src/om/memory-fold.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/om/memory-fold.js")>();
  foldMemoryMock.mockImplementation(actual.foldMemory);
  return { ...actual, foldMemory: foldMemoryMock };
});

vi.mock("../src/merge/pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/merge/pipeline.js")>();
  mergePipelinesMock.mockImplementation(actual.mergePipelines);
  return { ...actual, mergePipelines: mergePipelinesMock };
});

import { registerCompactionHook } from "../src/compaction-hook.js";
import { Runtime } from "../src/runtime.js";
import { OBSERVATION_CUSTOM_TYPE } from "../src/types.js";
import type { Entry, ObservationEntryData, ObservationRecord } from "../src/types.js";

const observation = (id: string, content = "durable fact"): ObservationRecord => ({
  id,
  content,
  timestamp: "2026-08-25T00:00:00Z",
  relevance: "high",
  sourceEntryIds: ["1234abcd"],
});

const source = (id: string): Entry => ({
  type: "message",
  id,
  timestamp: "2026-08-25T00:00:00Z",
  message: { role: "user", content: `message ${id}`, timestamp: 1 },
});

const observationEntry = (
  id: string,
  coversFromId: string,
  coversUpToId: string,
  records: ObservationRecord[],
): Entry => ({
  type: "custom",
  id,
  customType: OBSERVATION_CUSTOM_TYPE,
  data: { records, coversFromId, coversUpToId, tokenCount: 1 } satisfies ObservationEntryData,
});

const compaction = (id: string, firstKeptEntryId: string): Entry => ({
  type: "compaction",
  id,
  firstKeptEntryId,
  summary: "prior summary",
  details: {
    type: "observational-memory",
    version: 4,
    observations: [observation("aaaaaaaaaaaa", "prior committed fact")],
    reflections: [],
  },
});

const branch = (): Entry[] => [
  compaction("comp-1", "raw-0"),
  source("raw-0"),
  observationEntry("obs-boundary", "raw-0", "raw-0", []),
  source("raw-1"),
  source("new-kept"),
];

const warmEpoch = (runtime: Runtime, coverageEndId: string) => {
  const prepared = runtime.observerEpoch.prepare({
    compatibilityKey: "test|openai-completions|model|observer-v3-provenance|record-observations-v4-native|source-segments-v2",
    expectedCoverageId: "initial",
    baselineText: "baseline",
    deltaText: "delta",
    maxTokens: 100_000,
    fixedTokens: 6_144,
  });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error("failed to prepare epoch fixture");
  runtime.observerEpoch.commit(prepared, [...prepared.prompts, assistantMessage("done")], coverageEndId);
};

const setup = (entries: Entry[]) => {
  let handler: ((event: any, ctx: any) => Promise<unknown>) | undefined;
  let leafId = "new-kept";
  const appendEntry = vi.fn(() => { leafId = "appended-observation"; });
  const pi = {
    on: vi.fn((event: string, registered: typeof handler) => {
      if (event === "session_before_compact") handler = registered;
    }),
    appendEntry,
  };
  const runtime = new Runtime();
  runtime.loadedConfig = true;
  runtime.config.hybrid.reflectionThresholdTokens = Number.MAX_SAFE_INTEGER;
  registerCompactionHook(pi as never, runtime);

  let sessionId = "session-a";
  const complete = vi.fn();
  const ctx = {
    cwd: "/project",
    isProjectTrusted: () => true,
    hasUI: false,
    model: { provider: "test", api: "openai-completions", id: "model", contextWindow: 272_000 },
    modelRegistry: { find: vi.fn(), complete },
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => leafId,
      getBranch: () => entries,
    },
  };
  const event = {
    preparation: {
      firstKeptEntryId: "new-kept",
      tokensBefore: 50_000,
      previousSummary: "",
      fileOps: undefined,
    },
    branchEntries: entries,
    signal: undefined,
  };

  return {
    appendEntry,
    complete,
    event,
    getHandler: () => {
      if (!handler) throw new Error("compaction hook was not registered");
      return handler;
    },
    runtime,
    ctx,
    setLeafId: (value: string) => { leafId = value; },
    setSessionId: (value: string) => { sessionId = value; },
  };
};

describe("compaction catch-up safety integration", () => {
  beforeEach(() => {
    runObserverMock.mockReset();
    foldMemoryMock.mockClear();
    mergePipelinesMock.mockClear();
  });

  it("cold-resets a warm epoch when the current branch coverage anchor differs", async () => {
    const fixture = setup(branch());
    warmEpoch(fixture.runtime, "branch-a-source");
    let prefixTelemetry: unknown;
    runObserverMock.mockImplementation(async (params: any) => {
      prefixTelemetry = params.prefixTelemetry;
      return {
        ok: true,
        records: [observation("bbbbbbbbbbbb")],
        transcriptSuffix: [...params.prompts, assistantMessage("recorded")],
      };
    });

    await fixture.getHandler()(fixture.event, fixture.ctx);

    expect(prefixTelemetry).toMatchObject({
      cold: true,
      resetReason: "coverage-discontinuity",
    });
  });

  it("cancels if the session changes while awaiting an in-flight observer", async () => {
    const fixture = setup(branch());
    void fixture.runtime.observerTask.start({
      session: fixture.ctx.sessionManager,
      run: async () => { fixture.setSessionId("session-b"); },
    });

    const result = await fixture.getHandler()(fixture.event, fixture.ctx);

    expect(result).toEqual({ cancel: true });
    expect(foldMemoryMock).not.toHaveBeenCalled();
  });

  it("cancels if unrelated branch navigation occurs while awaiting an in-flight observer", async () => {
    const fixture = setup(branch());
    void fixture.runtime.observerTask.start({
      session: fixture.ctx.sessionManager,
      run: async () => { fixture.setLeafId("other-branch-leaf"); },
    });

    const result = await fixture.getHandler()(fixture.event, fixture.ctx);

    expect(result).toEqual({ cancel: true });
    expect(foldMemoryMock).not.toHaveBeenCalled();
  });

  it("cancels without persisting if the active branch changes during catch-up", async () => {
    const fixture = setup(branch());
    runObserverMock.mockImplementation(async (params: any) => {
      fixture.setLeafId("other-branch-leaf");
      return {
        ok: true,
        records: [observation("bbbbbbbbbbbb")],
        transcriptSuffix: [...params.prompts, assistantMessage("recorded")],
      };
    });

    const result = await fixture.getHandler()(fixture.event, fixture.ctx);

    expect(result).toEqual({ cancel: true });
    expect(fixture.appendEntry).not.toHaveBeenCalled();
  });

  it("accepts its own catch-up persistence as the new final-fence leaf", async () => {
    const fixture = setup(branch());
    runObserverMock.mockImplementation(async (params: any) => ({
      ok: true,
      records: [observation("bbbbbbbbbbbb")],
      transcriptSuffix: [...params.prompts, assistantMessage("recorded")],
    }));

    const result = await fixture.getHandler()(fixture.event, fixture.ctx);

    expect(result).toHaveProperty("compaction");
    expect(fixture.appendEntry).toHaveBeenCalledOnce();
  });

  it("supplies memory folding with a current ModelRegistry completion adapter", async () => {
    const fixture = setup(branch());
    fixture.runtime.config.hybrid.reflectionThresholdTokens = 0;
    runObserverMock.mockImplementation(async (params: any) => ({
      ok: true,
      records: [],
      transcriptSuffix: [...params.prompts, assistantMessage("examined")],
    }));
    foldMemoryMock.mockImplementationOnce(async (input: any) => {
      await input.modelPort.propose(input.params, "system", "evidence", {
        maxOutputTokens: 4_096,
        maxReflections: 4,
        maxReflectionContentChars: 2_048,
        estimatedInputTokens: 100,
        providerOutputReserveTokens: 1_000,
        estimatedWorstCaseContractTokens: 1_000,
        estimatedWorstCaseOutputTokens: 2_000,
      });
      return {
        ok: false,
        stage: "reflection",
        reason: "missing-tool-call",
        reflections: input.reflections,
        observations: input.observations,
        retiredObservationIds: [],
      };
    });
    fixture.complete.mockResolvedValue(assistantMessage("no tool call"));

    await fixture.getHandler()(fixture.event, fixture.ctx);

    expect(fixture.complete).toHaveBeenCalledOnce();
    const [, context, options] = fixture.complete.mock.calls[0];
    expect(context.tools[0].name).toBe("submit_reflections");
    expect(options).toMatchObject({
      maxRetries: 0,
      timeoutMs: 300_000,
    });
    expect(options).not.toHaveProperty("toolChoice");
    expect(options).not.toHaveProperty("reasoningEffort");
  });

  it("cancels if the active branch changes while memory folding is in progress", async () => {
    const entries = branch();
    const fixture = setup(entries);
    fixture.runtime.config.hybrid.reflectionThresholdTokens = 0;
    foldMemoryMock.mockImplementationOnce(async (input: any) => {
      fixture.setLeafId("other-branch-leaf");
      return {
        ok: true,
        outcome: "reflected",
        reflections: input.reflections,
        observations: input.observations,
        retiredObservationIds: [],
      };
    });

    const result = await fixture.getHandler()(fixture.event, fixture.ctx);

    expect(result).toEqual({ cancel: true });
    expect(mergePipelinesMock).not.toHaveBeenCalled();
  });

  it("keeps the live epoch invalidated if final assembly fails after catch-up persistence", async () => {
    const fixture = setup(branch());
    warmEpoch(fixture.runtime, "raw-0");
    runObserverMock.mockImplementation(async (params: any) => ({
      ok: true,
      records: [observation("bbbbbbbbbbbb")],
      transcriptSuffix: [...params.prompts, assistantMessage("recorded")],
    }));
    mergePipelinesMock.mockImplementationOnce(() => {
      throw new Error("assembly failed");
    });

    await expect(fixture.getHandler()(fixture.event, fixture.ctx)).rejects.toThrow("assembly failed");

    expect(fixture.appendEntry).toHaveBeenCalledWith(
      OBSERVATION_CUSTOM_TYPE,
      expect.objectContaining({ coversUpToId: "raw-1" }),
    );
    expect(fixture.runtime.observerEpoch.stats()).toMatchObject({
      active: false,
      lastResetReason: "catch-up-persisted",
    });
  });
});
