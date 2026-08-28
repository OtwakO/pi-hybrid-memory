import { beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMessage } from "./fixtures/messages.js";

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
    compatibilityKey: "test|openai-completions|model|observer-v6-bounded-context|record-observations-v5-native|source-segments-v2",
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
  runtime.ensureConfig = vi.fn();
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
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
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
  });

  it("cancels if unrelated branch navigation occurs while awaiting an in-flight observer", async () => {
    const fixture = setup(branch());
    void fixture.runtime.observerTask.start({
      session: fixture.ctx.sessionManager,
      run: async () => { fixture.setLeafId("other-branch-leaf"); },
    });

    const result = await fixture.getHandler()(fixture.event, fixture.ctx);

    expect(result).toEqual({ cancel: true });
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

  it("keeps pending observations that precede a newer non-memory compaction", async () => {
    const beforeNative = observation("bbbbbbbbbbbb", "pending before native compaction");
    const entries: Entry[] = [
      compaction("comp-1", "raw-0"),
      source("raw-0"),
      source("before-native"),
      observationEntry("obs-before-native", "before-native", "before-native", [beforeNative]),
      {
        type: "compaction",
        id: "native-1",
        firstKeptEntryId: "new-kept",
        summary: "native summary",
      },
      source("new-kept"),
    ];
    const fixture = setup(entries);
    fixture.event.preparation.firstKeptEntryId = "new-kept";

    await fixture.getHandler()(fixture.event, fixture.ctx);

    expect(mergePipelinesMock).toHaveBeenCalledWith(expect.objectContaining({
      observations: expect.arrayContaining([expect.objectContaining({ id: beforeNative.id })]),
    }));
  });

  it("builds VCC from Pi's removed delta without duplicating the retained tail", async () => {
    const entries = branch();
    const retained = entries.find((entry) => entry.id === "new-kept");
    if (retained?.type === "message") {
      retained.message = { role: "user", content: "Implement retained-tail-only feature", timestamp: 2 };
    }
    const fixture = setup(entries);
    fixture.event.preparation.messagesToSummarize = [{
      role: "user",
      content: "Implement removed-history feature",
      timestamp: 1,
    }];
    runObserverMock.mockImplementation(async (params: any) => ({
      ok: true,
      records: [],
      transcriptSuffix: [...params.prompts, assistantMessage("examined")],
    }));

    await fixture.getHandler()(fixture.event, fixture.ctx);

    const vccSummary = mergePipelinesMock.mock.calls.at(-1)?.[0]?.vccSummary as string;
    expect(vccSummary).toContain("removed-history feature");
    expect(vccSummary).not.toContain("retained-tail-only feature");
  });

  it("advances at most one durable catch-up segment before cancelling behind remaining backlog", async () => {
    const entries = branch();
    const raw = entries.find(entry => entry.id === "raw-1");
    if (raw?.type === "message") {
      raw.message = { role: "user", content: "large durable source ".repeat(2_000), timestamp: 1 };
    }
    const fixture = setup(entries);
    fixture.runtime.config.hybrid.observerChunkMaxTokens = 512;
    runObserverMock.mockImplementation(async (params: any) => ({
      ok: true,
      records: [observation("bbbbbbbbbbbb")],
      transcriptSuffix: [...params.prompts, assistantMessage("recorded")],
    }));

    const result = await fixture.getHandler()(fixture.event, fixture.ctx);

    expect(result).toEqual({ cancel: true });
    expect(runObserverMock).toHaveBeenCalledOnce();
    expect(fixture.appendEntry).toHaveBeenCalledWith(
      OBSERVATION_CUSTOM_TYPE,
      expect.objectContaining({
        coversFromId: "raw-1",
        coversUpToId: "raw-0",
        sourceProgress: expect.objectContaining({ sourceEntryId: "raw-1" }),
      }),
    );
    expect(mergePipelinesMock).not.toHaveBeenCalled();
  });

  it("persists a durable coverage marker when catch-up finds no observations", async () => {
    const fixture = setup(branch());
    runObserverMock.mockImplementation(async (params: any) => ({
      ok: true,
      records: [],
      transcriptSuffix: [...params.prompts, assistantMessage("examined")],
    }));

    const result = await fixture.getHandler()(fixture.event, fixture.ctx);

    expect(result).toHaveProperty("compaction");
    expect((result as any).compaction.details).toMatchObject({
      type: "observational-memory",
      version: 6,
      generation: {
        parentLifecycleEntryId: "comp-1",
        inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      reflectionsAdded: [],
      observationsRetired: [],
      reflectionsSuperseded: [],
    });
    expect((result as any).compaction.details).not.toHaveProperty("observations");
    expect((result as any).compaction.details).not.toHaveProperty("reflections");
    expect(fixture.appendEntry).toHaveBeenCalledWith(
      OBSERVATION_CUSTOM_TYPE,
      expect.objectContaining({
        records: [],
        coversFromId: "raw-1",
        coversUpToId: "raw-1",
        tokenCount: 0,
      }),
    );
    expect(fixture.runtime.observerEpoch.stats()).toMatchObject({
      active: false,
      lastResetReason: "compaction",
    });
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

  it("compacts covered memory locally without an active model", async () => {
    const entries = branch();
    entries.splice(3, 1);
    const fixture = setup(entries);
    fixture.ctx.model = undefined;

    const result = await fixture.getHandler()(fixture.event, fixture.ctx);

    expect(result).toHaveProperty("compaction");
    expect(fixture.complete).not.toHaveBeenCalled();
  });

  it("performs zero reflector completions while preserving exact-duplicate retirement", async () => {
    const entries = branch();
    const duplicate = observation("bbbbbbbbbbbb", "prior committed fact");
    entries.splice(3, 0, observationEntry("obs-duplicate", "raw-0", "raw-0", [duplicate]));
    const fixture = setup(entries);
    runObserverMock.mockImplementation(async (params: any) => ({
      ok: true,
      records: [],
      transcriptSuffix: [...params.prompts, assistantMessage("examined")],
    }));

    const result = await fixture.getHandler()(fixture.event, fixture.ctx);

    expect(result).toHaveProperty("compaction");
    expect(fixture.complete).not.toHaveBeenCalled();
    expect((result as any).compaction.details).toMatchObject({
      type: "observational-memory",
      version: 6,
      reflectionsAdded: [],
      reflectionsSuperseded: [],
      observationsRetired: [{
        observationId: duplicate.id,
        reason: "exact-duplicate",
        preservedByObservationIds: ["aaaaaaaaaaaa"],
      }],
    });
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
