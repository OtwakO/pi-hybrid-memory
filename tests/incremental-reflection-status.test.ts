import { describe, expect, it } from "vitest";

import { buildBranchMemoryIndex } from "../src/om/branch-memory-index.js";
import { buildIncrementalReflectionStatus } from "../src/om/incremental-reflection-status.js";
import { MEMORY_LIFECYCLE_CUSTOM_TYPE, OBSERVATION_CUSTOM_TYPE } from "../src/types.js";
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
    tokenCount: 10,
  } satisfies ObservationEntryData,
});

const status = (entries: Entry[], focusObservationTokens = 2_000) => {
  const index = buildBranchMemoryIndex(entries);
  return buildIncrementalReflectionStatus({
    entries,
    index,
    compatibilityVersion: "reflection-v1",
    focusObservationTokens,
  });
};

describe("incremental reflection status", () => {
  it("reports compatible frontier, backlog, and next bounded window", () => {
    const first = observation("aaaaaaaaaaaa", "first fact");
    const second = observation("bbbbbbbbbbbb", "second fact");
    const entries: Entry[] = [
      observationEntry("obsentry1", [first]),
      observationEntry("obsentry2", [second]),
      {
        type: "custom",
        id: "life0001",
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
      },
    ];

    expect(status(entries)).toEqual({
      compatibleFrontierEntryId: "obsentry1",
      totalObservationEntries: 2,
      consideredObservationEntries: 1,
      remainingObservationEntries: 1,
      nextWindow: {
        kind: "work",
        targetObservationEntryId: "obsentry2",
        observationEntryCount: 1,
        focusObservationCount: 1,
      },
    });
  });

  it("reports a blocked oversized next entry", () => {
    const oversized = observation("aaaaaaaaaaaa", "oversized ".repeat(1_000));

    expect(status([observationEntry("obsentry1", [oversized])], 50)).toMatchObject({
      remainingObservationEntries: 1,
      nextWindow: {
        kind: "blocked",
        observationEntryId: "obsentry1",
        observationCount: 1,
      },
    });
  });
});
