import { describe, expect, it } from "vitest";

import { buildBranchMemoryIndex } from "../src/om/branch-memory-index.js";
import { planNextReflectionWindow } from "../src/om/reflection-processor-plan.js";
import { OBSERVATION_CUSTOM_TYPE } from "../src/types.js";
import type { Entry, ObservationEntryData, ObservationRecord } from "../src/types.js";

const observation = (id: string, content: string): ObservationRecord => ({
  id,
  content,
  timestamp: "2026-08-28T00:00:00.000Z",
  relevance: "high",
  sourceEntryIds: [id.slice(0, 8)],
});

const observationEntry = (id: string, records: ObservationRecord[]): Entry => ({
  type: "custom",
  id,
  customType: OBSERVATION_CUSTOM_TYPE,
  data: {
    records,
    coversFromId: records[0]?.sourceEntryIds?.[0] ?? "source00",
    coversUpToId: records.at(-1)?.sourceEntryIds?.[0] ?? "source00",
    tokenCount: records.reduce((sum, record) => sum + record.content.length, 0),
  } satisfies ObservationEntryData,
});

const plan = (entries: Entry[], input: Partial<Parameters<typeof planNextReflectionWindow>[0]> = {}) => {
  const index = buildBranchMemoryIndex(entries);
  return planNextReflectionWindow({
    entries,
    index,
    compatibilityVersion: "reflection-v1",
    focusObservationTokens: 2_000,
    ...input,
  });
};

describe("incremental reflection processor plan", () => {
  it("selects the next contiguous observation-entry window after the compatible frontier", () => {
    const first = observation("aaaaaaaaaaaa", "first durable fact");
    const second = observation("bbbbbbbbbbbb", "second durable fact");
    const entries = [
      observationEntry("obsentry1", [first]),
      observationEntry("obsentry2", []),
      observationEntry("obsentry3", [second]),
    ];

    const index = buildBranchMemoryIndex(entries);
    const result = planNextReflectionWindow({
      entries,
      index: { ...index, reflectionProgress: {
        consideredThroughObservationEntryId: "obsentry1",
        compatibilityVersion: "reflection-v1",
      } },
      compatibilityVersion: "reflection-v1",
      focusObservationTokens: 2_000,
    });

    expect(result).toEqual({
      kind: "work",
      targetObservationEntryId: "obsentry3",
      observationEntryIds: ["obsentry2", "obsentry3"],
      focusObservations: [second],
    });
  });

  it("restarts from the beginning when the reflection policy version changes", () => {
    const first = observation("aaaaaaaaaaaa", "first durable fact");
    const second = observation("bbbbbbbbbbbb", "second durable fact");
    const entries = [observationEntry("obsentry1", [first]), observationEntry("obsentry2", [second])];

    const index = buildBranchMemoryIndex(entries);
    const result = planNextReflectionWindow({
      entries,
      index: { ...index, reflectionProgress: {
        consideredThroughObservationEntryId: "obsentry2",
        compatibilityVersion: "reflection-v0",
      } },
      compatibilityVersion: "reflection-v1",
      focusObservationTokens: 2_000,
    });

    expect(result).toMatchObject({
      kind: "work",
      targetObservationEntryId: "obsentry2",
      observationEntryIds: ["obsentry1", "obsentry2"],
      focusObservations: [first, second],
    });
  });

  it("returns no work after the latest compatible frontier", () => {
    const entries = [observationEntry("obsentry1", [])];

    const index = buildBranchMemoryIndex(entries);
    expect(planNextReflectionWindow({
      entries,
      index: { ...index, reflectionProgress: {
        consideredThroughObservationEntryId: "obsentry1",
        compatibilityVersion: "reflection-v1",
      } },
      compatibilityVersion: "reflection-v1",
      focusObservationTokens: 2_000,
    })).toEqual({ kind: "none" });
  });

  it("does not advance past an observation entry whose active evidence cannot fit", () => {
    const oversized = observation("aaaaaaaaaaaa", "oversized durable fact ".repeat(300));
    const entries = [observationEntry("obsentry1", [oversized])];

    expect(plan(entries, { focusObservationTokens: 100 })).toEqual({
      kind: "blocked",
      observationEntryId: "obsentry1",
      observationCount: 1,
    });
  });

  it("omits retired observations while still advancing across their journal entry", () => {
    const retired = observation("aaaaaaaaaaaa", "retired duplicate");
    const entries = [observationEntry("obsentry1", [retired])];
    const index = buildBranchMemoryIndex(entries);
    const result = planNextReflectionWindow({
      entries,
      index: {
        ...index,
        activeObservationIds: () => new Set(),
      },
      compatibilityVersion: "reflection-v1",
      focusObservationTokens: 100,
    });

    expect(result).toEqual({
      kind: "work",
      targetObservationEntryId: "obsentry1",
      observationEntryIds: ["obsentry1"],
      focusObservations: [],
    });
  });
});
