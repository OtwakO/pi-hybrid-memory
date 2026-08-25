import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@mariozechner/pi-ai";

const runObserverMock = vi.hoisted(() => vi.fn());
const mergePipelinesMock = vi.hoisted(() => vi.fn());

vi.mock("../src/om/observer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/om/observer.js")>();
  return { ...actual, runObserver: runObserverMock };
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

const assistant = (content: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text: content }],
  api: "openai-completions",
  provider: "test",
  model: "model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
});

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
    compatibilityKey: "test|openai-completions|model|observer-v3-provenance|record-observations-v3|source-segments-v2",
    expectedCoverageId: "initial",
    baselineText: "baseline",
    deltaText: "delta",
    maxTokens: 100_000,
    fixedTokens: 6_144,
  });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error("failed to prepare epoch fixture");
  runtime.observerEpoch.commit(prepared, [...prepared.prompts, assistant("done")], coverageEndId);
};

const setup = (entries: Entry[]) => {
  let handler: ((event: any, ctx: any) => Promise<unknown>) | undefined;
  const appendEntry = vi.fn();
  const pi = {
    on: vi.fn((event: string, registered: typeof handler) => {
      if (event === "session_before_compact") handler = registered;
    }),
    appendEntry,
  };
  const runtime = new Runtime();
  runtime.loadedConfig = true;
  runtime.config.hybrid.reflectionThresholdTokens = Number.MAX_SAFE_INTEGER;
  vi.spyOn(runtime, "resolveModel").mockResolvedValue({
    ok: true,
    model: { provider: "test", api: "openai-completions", id: "model", contextWindow: 272_000 },
    apiKey: "key",
  });
  registerCompactionHook(pi as never, runtime);

  let sessionId = "session-a";
  let leafId = "new-kept";
  const ctx = {
    cwd: "/project",
    hasUI: false,
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
        transcriptSuffix: [...params.prompts, assistant("recorded")],
      };
    });

    await fixture.getHandler()(fixture.event, fixture.ctx);

    expect(prefixTelemetry).toMatchObject({
      cold: true,
      resetReason: "coverage-discontinuity",
    });
  });

  it("cancels without persisting if the active branch changes during catch-up", async () => {
    const fixture = setup(branch());
    runObserverMock.mockImplementation(async (params: any) => {
      fixture.setLeafId("other-branch-leaf");
      return {
        ok: true,
        records: [observation("bbbbbbbbbbbb")],
        transcriptSuffix: [...params.prompts, assistant("recorded")],
      };
    });

    const result = await fixture.getHandler()(fixture.event, fixture.ctx);

    expect(result).toEqual({ cancel: true });
    expect(fixture.appendEntry).not.toHaveBeenCalled();
  });

  it("keeps the live epoch invalidated if final assembly fails after catch-up persistence", async () => {
    const fixture = setup(branch());
    warmEpoch(fixture.runtime, "raw-0");
    runObserverMock.mockImplementation(async (params: any) => ({
      ok: true,
      records: [observation("bbbbbbbbbbbb")],
      transcriptSuffix: [...params.prompts, assistant("recorded")],
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
