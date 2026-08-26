import { describe, expect, it } from "vitest";

import { buildBranchMemoryIndex } from "../src/om/branch-memory-index.js";
import { OBSERVATION_CUSTOM_TYPE } from "../src/types.js";
import type {
  Entry,
  MemoryDetailsV4,
  ObservationEntryData,
  ObservationRecord,
  ReflectionRecord,
} from "../src/types.js";

const source = (id: string): Entry => ({
  type: "message",
  id,
  timestamp: "2026-08-26T00:00:00.000Z",
  message: { role: "user", content: `source ${id}` },
});

const observation = (
  id: string,
  content: string,
  timestamp: string,
  sourceEntryIds?: string[],
): ObservationRecord => ({ id, content, timestamp, relevance: "high", sourceEntryIds });

const reflection = (id: string, content: string, supportingObservationIds: string[]): ReflectionRecord => ({
  id,
  content,
  supportingObservationIds,
});

const details = (
  observations: ObservationRecord[],
  reflections: MemoryDetailsV4["reflections"] = [],
): MemoryDetailsV4 => ({
  type: "observational-memory",
  version: 4,
  observations,
  reflections,
});

const compaction = (
  id: string,
  firstKeptEntryId: string,
  memoryDetails: unknown,
): Entry => ({
  type: "compaction",
  id,
  firstKeptEntryId,
  summary: `summary ${id}`,
  details: memoryDetails,
});

const observationEntry = (
  id: string,
  coversFromId: string,
  records: ObservationRecord[],
): Entry => {
  const data: ObservationEntryData = {
    records,
    coversFromId,
    coversUpToId: coversFromId,
    tokenCount: 10,
  };
  return { type: "custom", id, customType: OBSERVATION_CUSTOM_TYPE, data };
};

describe("branch memory index", () => {
  it("projects latest committed memory and post-boundary pending observations", () => {
    const committed = observation("aaaaaaaaaaaa", "committed", "2026-08-26T00:00:01.000Z");
    const pending = observation("bbbbbbbbbbbb", "pending", "2026-08-26T00:00:02.000Z");
    const currentReflection = reflection("cccccccccccc", "current reflection", [committed.id]);
    const entries: Entry[] = [
      source("oldsrc01"),
      compaction("compact1", "kept0011", details([committed], [currentReflection])),
      source("kept0011"),
      source("newsrc01"),
      observationEntry("obsentry1", "newsrc01", [pending]),
    ];

    const index = buildBranchMemoryIndex(entries);

    expect(index.current.committedObs).toEqual([committed]);
    expect(index.current.pendingObs).toEqual([pending]);
    expect(index.current.reflections).toEqual([currentReflection]);
  });

  it("rejects a conflicting legacy snapshot atomically while preserving canonical custom evidence", () => {
    const carried = observation("aaaaaaaaaaaa", "carried copy", "2026-08-26T00:00:01.000Z");
    const original = observation("aaaaaaaaaaaa", "original copy", "2026-08-26T00:00:01.000Z");
    const compactOnly = observation("bbbbbbbbbbbb", "compaction only", "2026-08-26T00:00:02.000Z");
    const entries: Entry[] = [
      source("source01"),
      observationEntry("obsentry1", "source01", [original]),
      compaction("compact1", "kept0011", details([carried, compactOnly])),
      source("kept0011"),
    ];

    const index = buildBranchMemoryIndex(entries);

    expect(index.observationById(carried.id)?.content).toBe("original copy");
    expect(index.observationById(compactOnly.id)).toBeUndefined();
    expect(index.issues).toEqual([expect.objectContaining({
      entryId: "compact1",
      reason: "conflicting-observation",
    })]);
  });

  it("uses the latest valid memory details even when a newer compaction has none", () => {
    const committed = observation("aaaaaaaaaaaa", "preserved", "2026-08-26T00:00:01.000Z");
    const beforeNative = observation("bbbbbbbbbbbb", "before native", "2026-08-26T00:00:02.000Z");
    const afterNative = observation("cccccccccccc", "after native", "2026-08-26T00:00:03.000Z");
    const entries: Entry[] = [
      compaction("hybrid01", "kept0001", details([committed])),
      source("kept0001"),
      source("source01"),
      observationEntry("obsentry1", "source01", [beforeNative]),
      compaction("native01", "kept0002", undefined),
      source("kept0002"),
      source("source02"),
      observationEntry("obsentry2", "source02", [afterNative]),
    ];

    const index = buildBranchMemoryIndex(entries);

    expect(index.current.committedObs).toEqual([committed]);
    expect(index.current.pendingObs).toEqual([beforeNative, afterNative]);
  });

  it("keeps latest current reflections while retaining addressable reflection history", () => {
    const oldReflection = reflection("aaaaaaaaaaaa", "old reflection", []);
    const currentReflection = reflection("bbbbbbbbbbbb", "current reflection", []);
    const entries: Entry[] = [
      compaction("compact1", "kept0001", details([], [oldReflection])),
      source("kept0001"),
      compaction("compact2", "kept0002", details([], [currentReflection])),
      source("kept0002"),
    ];

    const index = buildBranchMemoryIndex(entries);

    expect(index.current.reflections).toEqual([currentReflection]);
    expect(index.reflectionById(oldReflection.id)).toEqual(oldReflection);
    expect(index.reflectionById(currentReflection.id)).toEqual(currentReflection);
  });

  it("traverses reflection evidence through observations to deduplicated source entries", () => {
    const first = observation(
      "aaaaaaaaaaaa",
      "first fact",
      "2026-08-26T00:00:01.000Z",
      ["source01", "shared01"],
    );
    const second = observation(
      "bbbbbbbbbbbb",
      "second fact",
      "2026-08-26T00:00:02.000Z",
      ["shared01", "missing1"],
    );
    const synthesis = reflection(
      "cccccccccccc",
      "synthesis",
      [first.id, "dddddddddddd", second.id],
    );
    const entries: Entry[] = [
      source("source01"),
      source("shared01"),
      observationEntry("obsentry1", "source01", [first, second]),
      compaction("compact1", "kept0011", details([first, second], [synthesis])),
      source("kept0011"),
    ];

    expect(buildBranchMemoryIndex(entries).evidenceForReflection(synthesis.id)).toEqual({
      observations: [first, second],
      entries: [entries[0], entries[1]],
      missingObservationIds: ["dddddddddddd"],
      missingIds: ["missing1"],
    });
  });

  it("resolves observation provenance in cited order and reports unavailable sources", () => {
    const record = observation(
      "aaaaaaaaaaaa",
      "fact",
      "2026-08-26T00:00:01.000Z",
      ["source02", "missing1", "source01"],
    );
    const entries: Entry[] = [
      source("source01"),
      source("source02"),
      observationEntry("obsentry1", "source01", [record]),
    ];

    const index = buildBranchMemoryIndex(entries);

    expect(index.sourcesForObservation(record.id)).toEqual({
      entries: [entries[1], entries[0]],
      missingIds: ["missing1"],
    });
    expect(index.sourceEntryById("source01")).toEqual(entries[0]);
  });

  it("replays V5 reflection additions over a V4 baseline without copying observations", () => {
    const committed = observation("aaaaaaaaaaaa", "committed", "2026-08-26T00:00:01.000Z");
    const firstReflection = reflection("bbbbbbbbbbbb", "first reflection", [committed.id]);
    const secondReflection = reflection("cccccccccccc", "second reflection", [committed.id]);
    const entries: Entry[] = [
      observationEntry("obsentry1", "source01", [committed]),
      compaction("compact1", "kept0001", details([committed])),
      source("kept0001"),
      compaction("compact2", "kept0002", {
        type: "observational-memory",
        version: 5,
        generation: { inputFingerprint: "first", parentMemoryCompactionId: "compact1" },
        reflectionsAdded: [firstReflection],
        observationsRetired: [],
        reflectionsSuperseded: [],
      }),
      source("kept0002"),
      compaction("compact3", "kept0003", {
        type: "observational-memory",
        version: 5,
        generation: { inputFingerprint: "second", parentMemoryCompactionId: "compact2" },
        reflectionsAdded: [secondReflection],
        observationsRetired: [],
        reflectionsSuperseded: [],
      }),
      source("kept0003"),
    ];

    const index = buildBranchMemoryIndex(entries);

    expect(index.latestMemoryCompactionId).toBe("compact3");
    expect(index.current.committedObs).toEqual([committed]);
    expect(index.current.pendingObs).toEqual([]);
    expect(index.current.reflections).toEqual([firstReflection, secondReflection]);
  });

  it("rejects a malformed or wrong-parent V5 batch atomically", () => {
    const committed = observation("aaaaaaaaaaaa", "committed", "2026-08-26T00:00:01.000Z");
    const validReflection = reflection("bbbbbbbbbbbb", "valid", [committed.id]);
    const invalidReflection = reflection("cccccccccccc", "invalid", ["dddddddddddd"]);
    const entries: Entry[] = [
      compaction("compact1", "kept0001", details([committed])),
      source("kept0001"),
      compaction("compact2", "kept0002", {
        type: "observational-memory",
        version: 5,
        generation: { inputFingerprint: "valid", parentMemoryCompactionId: "compact1" },
        reflectionsAdded: [validReflection],
        observationsRetired: [],
        reflectionsSuperseded: [],
      }),
      source("kept0002"),
      compaction("compact3", "kept0003", {
        type: "observational-memory",
        version: 5,
        generation: { inputFingerprint: "wrong-parent", parentMemoryCompactionId: "compact1" },
        reflectionsAdded: [invalidReflection],
        observationsRetired: [],
        reflectionsSuperseded: [],
      }),
      source("kept0003"),
    ];

    const index = buildBranchMemoryIndex(entries);

    expect(index.latestMemoryCompactionId).toBe("compact2");
    expect(index.current.reflections).toEqual([validReflection]);
    expect(index.reflectionById(invalidReflection.id)).toBeUndefined();
    expect(index.issues).toEqual([expect.objectContaining({
      entryId: "compact3",
      reason: "invalid-lifecycle-parent",
    })]);
  });

  it("rejects conflicting duplicate ids inside the first V4 baseline atomically", () => {
    const first = observation("aaaaaaaaaaaa", "first", "2026-08-26T00:00:01.000Z");
    const conflict = observation("aaaaaaaaaaaa", "conflict", "2026-08-26T00:00:01.000Z");
    const index = buildBranchMemoryIndex([
      compaction("compact1", "kept0001", details([first, conflict])),
      source("kept0001"),
    ]);

    expect(index.latestMemoryCompactionId).toBeUndefined();
    expect(index.current.committedObs).toEqual([]);
    expect(index.observationById(first.id)).toBeUndefined();
    expect(index.issues).toEqual([expect.objectContaining({
      entryId: "compact1",
      reason: "conflicting-observation",
    })]);
  });

  it("reports malformed claimed V5 details while retaining prior state", () => {
    const committed = observation("aaaaaaaaaaaa", "committed", "2026-08-26T00:00:01.000Z");
    const index = buildBranchMemoryIndex([
      compaction("compact1", "kept0001", details([committed])),
      source("kept0001"),
      compaction("compact2", "kept0002", {
        type: "observational-memory",
        version: 5,
        generation: { inputFingerprint: "fingerprint", parentMemoryCompactionId: "compact1" },
        reflectionsAdded: [],
        observationsRetired: ["unsupported"],
        reflectionsSuperseded: [],
      }),
      source("kept0002"),
    ]);

    expect(index.latestMemoryCompactionId).toBe("compact1");
    expect(index.current.committedObs).toEqual([committed]);
    expect(index.issues).toEqual([expect.objectContaining({
      entryId: "compact2",
      reason: "invalid-lifecycle-batch",
    })]);
  });

  it("rejects malformed and unknown future compaction details from every view", () => {
    const entries: Entry[] = [
      compaction("compact1", "kept0001", {
        type: "observational-memory",
        version: 6,
        observations: [observation("aaaaaaaaaaaa", "future", "2026-08-26T00:00:01.000Z")],
        reflections: [],
      }),
      source("kept0001"),
    ];

    const index = buildBranchMemoryIndex(entries);

    expect(index.current).toEqual({ reflections: [], committedObs: [], pendingObs: [] });
    expect(index.observationById("aaaaaaaaaaaa")).toBeUndefined();
    expect(index.reflectionById("aaaaaaaaaaaa")).toBeUndefined();
  });

  it("rejects a conflicting custom observation batch atomically", () => {
    const original = observation("aaaaaaaaaaaa", "original", "2026-08-26T00:00:01.000Z");
    const conflict = observation("aaaaaaaaaaaa", "conflict", "2026-08-26T00:00:01.000Z");
    const innocent = observation("bbbbbbbbbbbb", "same rejected batch", "2026-08-26T00:00:02.000Z");
    const index = buildBranchMemoryIndex([
      observationEntry("obsentry1", "source01", [original]),
      observationEntry("obsentry2", "source02", [conflict, innocent]),
    ]);

    expect(index.observationById(original.id)).toEqual(original);
    expect(index.observationById(innocent.id)).toBeUndefined();
    expect(index.issues).toEqual([expect.objectContaining({
      entryId: "obsentry2",
      reason: "conflicting-observation",
    })]);
  });

  it("derives branch and fork state solely from the selected path", () => {
    const committed = observation("aaaaaaaaaaaa", "committed", "2026-08-26T00:00:01.000Z");
    const added = reflection("bbbbbbbbbbbb", "added later", [committed.id]);
    const beforeLifecycle: Entry[] = [
      observationEntry("obsentry1", "source01", [committed]),
      compaction("compact1", "kept0001", details([committed])),
      source("kept0001"),
    ];
    const afterLifecycle: Entry[] = [
      ...beforeLifecycle,
      compaction("compact2", "kept0002", {
        type: "observational-memory",
        version: 5,
        generation: { inputFingerprint: "fingerprint", parentMemoryCompactionId: "compact1" },
        reflectionsAdded: [added],
        observationsRetired: [],
        reflectionsSuperseded: [],
      }),
      source("kept0002"),
    ];

    expect(buildBranchMemoryIndex(beforeLifecycle).current.reflections).toEqual([]);
    expect(buildBranchMemoryIndex(afterLifecycle).current.reflections).toEqual([added]);
    expect(buildBranchMemoryIndex(structuredClone(afterLifecycle)).current).toEqual(
      buildBranchMemoryIndex(afterLifecycle).current,
    );
  });

  it("supports a root V5 journal when canonical observation evidence precedes it", () => {
    const committed = observation("aaaaaaaaaaaa", "committed", "2026-08-26T00:00:01.000Z");
    const added = reflection("bbbbbbbbbbbb", "root reflection", [committed.id]);
    const index = buildBranchMemoryIndex([
      observationEntry("obsentry1", "source01", [committed]),
      compaction("compact1", "kept0001", {
        type: "observational-memory",
        version: 5,
        generation: { inputFingerprint: "fingerprint" },
        reflectionsAdded: [added],
        observationsRetired: [],
        reflectionsSuperseded: [],
      }),
      source("kept0001"),
    ]);

    expect(index.latestMemoryCompactionId).toBe("compact1");
    expect(index.current.committedObs).toEqual([committed]);
    expect(index.current.reflections).toEqual([added]);
    expect(index.issues).toEqual([]);
  });

  it("returns isolated memory records from lookup methods", () => {
    const record = observation("aaaaaaaaaaaa", "original", "2026-08-26T00:00:01.000Z", ["source01"]);
    const index = buildBranchMemoryIndex([
      source("source01"),
      observationEntry("obsentry1", "source01", [record]),
    ]);

    const firstLookup = index.observationById(record.id);
    if (!firstLookup) throw new Error("expected indexed observation");
    firstLookup.content = "mutated";
    firstLookup.sourceEntryIds?.push("source02");

    expect(index.observationById(record.id)).toMatchObject({
      content: "original",
      sourceEntryIds: ["source01"],
    });
  });
});
