import { describe, expect, it, vi } from "vitest";

import { buildBranchMemoryIndex } from "../src/om/branch-memory-index.js";
import { processNextReflectionWindow } from "../src/om/incremental-reflection-processor.js";
import { MEMORY_LIFECYCLE_CUSTOM_TYPE, OBSERVATION_CUSTOM_TYPE } from "../src/types.js";
import type { Entry, ObservationEntryData, ObservationRecord } from "../src/types.js";
import type { MemoryFoldInput, MemoryFoldResult } from "../src/om/memory-fold.js";

const observation: ObservationRecord = {
  id: "aaaaaaaaaaaa",
  content: "durable fact",
  timestamp: "2026-08-28T00:00:00.000Z",
  relevance: "high",
  sourceEntryIds: ["source01"],
};

const source: Entry = {
  type: "message",
  id: "source01",
  timestamp: "2026-08-28T00:00:00.000Z",
  message: { role: "user", content: "source", timestamp: 1 },
};

const observationEntry = (records: ObservationRecord[]): Entry => ({
  type: "custom",
  id: "obsentry1",
  customType: OBSERVATION_CUSTOM_TYPE,
  data: {
    records,
    coversFromId: "source01",
    coversUpToId: "source01",
    tokenCount: 3,
  } satisfies ObservationEntryData,
});

const setup = (records: ObservationRecord[] = [observation]) => {
  const entries = [source, observationEntry(records)];
  let sessionId = "session-a";
  let leafId = "obsentry1";
  const session = {
    getSessionId: () => sessionId,
    getLeafId: () => leafId,
    getBranch: () => entries,
  };
  const appendEntry = vi.fn((customType: string, data: unknown) => {
    entries.push({ type: "custom", id: "life0001", customType, data });
    leafId = "life0001";
  });
  return {
    appendEntry,
    entries,
    session,
    setLeafId: (value: string) => { leafId = value; },
    setSessionId: (value: string) => { sessionId = value; },
  };
};

const successfulFold = (input: MemoryFoldInput): MemoryFoldResult => ({
  ok: true,
  outcome: "reflected",
  reflections: [{
    id: "bbbbbbbbbbbb",
    content: "durable reflection",
    supportingObservationIds: [observation.id],
  }],
  observations: input.observations,
  retirements: [],
  supersessions: [],
});

const run = (
  fixture: ReturnType<typeof setup>,
  fold: (input: MemoryFoldInput) => Promise<MemoryFoldResult>,
) => processNextReflectionWindow({
  session: fixture.session,
  appendEntry: fixture.appendEntry,
  compatibilityVersion: "reflection-v1",
  focusObservationTokens: 2_000,
  fold,
  foldInput: {
    params: { model: { contextWindow: 32_000, maxTokens: 8_000 }, apiKey: "key" },
    contextBudgets: {
      reflectionTokens: 256,
      focusObservationTokens: 2_000,
      protectedObservationTokens: 1_000,
      recentObservationTokens: 320,
    },
    reflectionThresholdTokens: 0,
    targetSummaryTokens: 16_000,
    modelPort: { propose: vi.fn() },
  },
});

describe("incremental reflection processor", () => {
  it("folds one bounded window and appends one validated lifecycle event", async () => {
    const fixture = setup();
    const fold = vi.fn(async (input: MemoryFoldInput) => successfulFold(input));

    expect(await run(fixture, fold)).toEqual({
      outcome: "persisted",
      targetObservationEntryId: "obsentry1",
      foldOutcome: "reflected",
    });
    expect(fold).toHaveBeenCalledWith(expect.objectContaining({
      focusObservations: [observation],
      observations: [observation],
      reflections: [],
    }));
    expect(fixture.appendEntry).toHaveBeenCalledWith(
      MEMORY_LIFECYCLE_CUSTOM_TYPE,
      expect.objectContaining({ version: 6 }),
    );
    const index = buildBranchMemoryIndex(fixture.entries);
    expect(index.reflectionProgress).toEqual({
      consideredThroughObservationEntryId: "obsentry1",
      compatibilityVersion: "reflection-v1",
    });
  });

  it("advances an empty observation entry without calling the model fold", async () => {
    const fixture = setup([]);
    const fold = vi.fn();

    expect(await run(fixture, fold)).toEqual({
      outcome: "persisted",
      targetObservationEntryId: "obsentry1",
      foldOutcome: "empty-window",
    });
    expect(fold).not.toHaveBeenCalled();
    expect(fixture.appendEntry).toHaveBeenCalledOnce();
  });

  it("does not persist below-threshold or failed folds", async () => {
    const below = setup();
    expect(await run(below, async (input) => ({
      ok: true,
      outcome: "below-threshold",
      reflections: input.reflections,
      observations: input.observations,
      retirements: [],
      supersessions: [],
    }))).toEqual({ outcome: "deferred", reason: "below-threshold" });
    expect(below.appendEntry).not.toHaveBeenCalled();

    const failed = setup();
    expect(await run(failed, async (input) => ({
      ok: false,
      stage: "reflection",
      reason: "timeout",
      reflections: input.reflections,
      observations: input.observations,
      retirements: [],
      supersessions: [],
    }))).toEqual({ outcome: "failed", reason: "timeout" });
    expect(failed.appendEntry).not.toHaveBeenCalled();
  });

  it("discards a successful fold when the branch changes before append", async () => {
    const fixture = setup();
    const result = await run(fixture, async (input) => {
      fixture.setLeafId("otherleaf");
      return successfulFold(input);
    });

    expect(result).toEqual({ outcome: "stale", reason: "branch-changed" });
    expect(fixture.appendEntry).not.toHaveBeenCalled();
  });

  it("returns no-work and blocked outcomes without calling the fold", async () => {
    const noWork = setup([]);
    noWork.entries.push({
      type: "custom",
      id: "life0000",
      customType: MEMORY_LIFECYCLE_CUSTOM_TYPE,
      data: {
        type: "observational-memory",
        version: 6,
        generation: { inputFingerprint: "0".repeat(64) },
        reflectionProgress: {
          consideredThroughObservationEntryId: "obsentry1",
          compatibilityVersion: "reflection-v1",
        },
        reflectionsAdded: [],
        observationsRetired: [],
        reflectionsSuperseded: [],
      },
    });
    noWork.setLeafId("life0000");
    const noWorkFold = vi.fn();
    expect(await run(noWork, noWorkFold)).toEqual({ outcome: "no-work" });
    expect(noWorkFold).not.toHaveBeenCalled();

    const blocked = setup([{ ...observation, content: "oversized ".repeat(1_000) }]);
    const blockedFold = vi.fn();
    const blockedResult = await processNextReflectionWindow({
      session: blocked.session,
      appendEntry: blocked.appendEntry,
      compatibilityVersion: "reflection-v1",
      focusObservationTokens: 50,
      fold: blockedFold,
      foldInput: {
        params: { model: { contextWindow: 32_000, maxTokens: 8_000 }, apiKey: "key" },
        contextBudgets: {
          reflectionTokens: 256,
          focusObservationTokens: 50,
          protectedObservationTokens: 1_000,
          recentObservationTokens: 320,
        },
        reflectionThresholdTokens: 0,
        targetSummaryTokens: 16_000,
        modelPort: { propose: vi.fn() },
      },
    });
    expect(blockedResult).toEqual({
      outcome: "blocked",
      observationEntryId: "obsentry1",
      observationCount: 1,
    });
    expect(blockedFold).not.toHaveBeenCalled();
  });
});
