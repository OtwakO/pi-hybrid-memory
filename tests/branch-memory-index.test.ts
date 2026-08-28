import { describe, expect, it } from "vitest";

import { buildBranchMemoryIndex } from "../src/om/branch-memory-index.js";
import { MEMORY_LIFECYCLE_CUSTOM_TYPE, OBSERVATION_CUSTOM_TYPE } from "../src/types.js";
import type {
  Entry,
  MemoryDetailsV4,
  ObservationEntryData,
  ObservationRecord,
  ReflectionRecord,
  MemoryLifecycleEventV6,
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

const lifecycleV6 = (
  id: string,
  event: MemoryLifecycleEventV6,
): Entry => ({ type: "custom", id, customType: MEMORY_LIFECYCLE_CUSTOM_TYPE, data: event });

const v6 = (input: {
  fingerprint: string;
  parentLifecycleEntryId?: string;
  frontier?: { entryId: string; compatibilityVersion?: string };
  reflectionsAdded?: ReflectionRecord[];
}): MemoryLifecycleEventV6 => ({
  type: "observational-memory",
  version: 6,
  generation: {
    inputFingerprint: input.fingerprint,
    ...(input.parentLifecycleEntryId ? { parentLifecycleEntryId: input.parentLifecycleEntryId } : {}),
  },
  ...(input.frontier
    ? { reflectionProgress: {
        consideredThroughObservationEntryId: input.frontier.entryId,
        compatibilityVersion: input.frontier.compatibilityVersion ?? "reflection-v1",
      } }
    : {}),
  reflectionsAdded: input.reflectionsAdded ?? [],
  observationsRetired: [],
  reflectionsSuperseded: [],
});

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

  it("retires a canonical duplicate from the active branch projection without deleting evidence", () => {
    const representative = observation("aaaaaaaaaaaa", "same\r\ncontent", "2026-08-26T00:00:01.000Z", ["source01"]);
    const duplicate = observation("bbbbbbbbbbbb", "  same\ncontent  ", "2026-08-26T00:00:02.000Z", ["source02"]);
    const entries: Entry[] = [
      source("source01"),
      source("source02"),
      observationEntry("obsentry1", "source01", [representative, duplicate]),
      compaction("compact1", "kept0001", {
        type: "observational-memory",
        version: 5,
        generation: { inputFingerprint: "retirement" },
        reflectionsAdded: [],
        observationsRetired: [{
          observationId: duplicate.id,
          reason: "exact-duplicate",
          preservedByObservationIds: [representative.id],
          preservedByReflectionIds: [],
        }],
        reflectionsSuperseded: [],
      }),
      source("kept0001"),
    ];

    const index = buildBranchMemoryIndex(entries);

    expect(index.current.committedObs).toEqual([representative]);
    expect(index.observationById(duplicate.id)).toEqual(duplicate);
    expect(index.observationLifecycle(duplicate.id)).toEqual({
      state: "retired",
      retirement: expect.objectContaining({
        reason: "exact-duplicate",
        preservedByObservationIds: [representative.id],
      }),
    });
  });

  it("keeps retirement branch-local and replay idempotent", () => {
    const representative = observation("aaaaaaaaaaaa", "same", "2026-08-26T00:00:01.000Z");
    const duplicate = observation("bbbbbbbbbbbb", "same", "2026-08-26T00:00:02.000Z");
    const beforeRetirement: Entry[] = [
      observationEntry("obsentry1", "source01", [representative, duplicate]),
    ];
    const afterRetirement: Entry[] = [
      ...beforeRetirement,
      compaction("compact1", "kept0001", {
        type: "observational-memory",
        version: 5,
        generation: { inputFingerprint: "retirement" },
        reflectionsAdded: [],
        observationsRetired: [{
          observationId: duplicate.id,
          reason: "exact-duplicate",
          preservedByObservationIds: [representative.id],
          preservedByReflectionIds: [],
        }],
        reflectionsSuperseded: [],
      }),
      source("kept0001"),
    ];

    expect(buildBranchMemoryIndex(beforeRetirement).current.committedObs).toEqual([representative, duplicate]);
    const after = buildBranchMemoryIndex(afterRetirement);
    expect([...after.current.committedObs, ...after.current.pendingObs]).toEqual([representative]);
    expect(buildBranchMemoryIndex(structuredClone(afterRetirement)).current).toEqual(
      buildBranchMemoryIndex(afterRetirement).current,
    );
  });

  it("rejects a malformed retirement batch atomically with its reflection additions", () => {
    const representative = observation("aaaaaaaaaaaa", "same", "2026-08-26T00:00:01.000Z");
    const duplicate = observation("bbbbbbbbbbbb", "same", "2026-08-26T00:00:02.000Z");
    const added = reflection("cccccccccccc", "must not partially apply", [representative.id]);
    const index = buildBranchMemoryIndex([
      observationEntry("obsentry1", "source01", [representative, duplicate]),
      compaction("compact1", "kept0001", {
        type: "observational-memory",
        version: 5,
        generation: { inputFingerprint: "invalid" },
        reflectionsAdded: [added],
        observationsRetired: [{
          observationId: representative.id,
          reason: "exact-duplicate",
          preservedByObservationIds: [duplicate.id],
          preservedByReflectionIds: [],
        }],
        reflectionsSuperseded: [],
      }),
      source("kept0001"),
    ]);

    expect(index.current.committedObs).toEqual([representative, duplicate]);
    expect(index.reflectionById(added.id)).toBeUndefined();
    expect(index.issues).toEqual([expect.objectContaining({
      entryId: "compact1",
      reason: "invalid-lifecycle-batch",
    })]);
  });

  it("replaces a strengthened reflection in the current projection but preserves revision history", () => {
    const first = reflection("aaaaaaaaaaaa", "durable reflection", ["bbbbbbbbbbbb"]);
    const successor = reflection("cccccccccccc", " durable   reflection ", ["bbbbbbbbbbbb", "dddddddddddd"]);
    const index = buildBranchMemoryIndex([
      observationEntry("obsentry1", "source01", [
        observation("bbbbbbbbbbbb", "first support"),
        observation("dddddddddddd", "second support"),
      ]),
      compaction("compact1", "kept0001", {
        type: "observational-memory",
        version: 5,
        generation: { inputFingerprint: "first" },
        reflectionsAdded: [first],
        observationsRetired: [],
        reflectionsSuperseded: [],
      }),
      source("kept0001"),
      compaction("compact2", "kept0002", {
        type: "observational-memory",
        version: 5,
        generation: { inputFingerprint: "strengthened", parentMemoryCompactionId: "compact1" },
        reflectionsAdded: [successor],
        observationsRetired: [],
        reflectionsSuperseded: [{
          reflectionId: first.id,
          supersededByReflectionId: successor.id,
          reason: "strengthened",
        }],
      }),
      source("kept0002"),
    ]);

    expect(index.current.reflections).toEqual([successor]);
    expect(index.reflectionById(first.id)).toEqual(first);
    expect(index.reflectionLifecycle(first.id)).toEqual({
      state: "superseded",
      supersession: expect.objectContaining({ supersededByReflectionId: successor.id }),
    });
  });

  it("rejects strengthening that drops predecessor support atomically", () => {
    const first = reflection("aaaaaaaaaaaa", "durable reflection", ["bbbbbbbbbbbb", "dddddddddddd"]);
    const invalidSuccessor = reflection("cccccccccccc", "durable reflection", ["bbbbbbbbbbbb", "eeeeeeeeeeee"]);
    const index = buildBranchMemoryIndex([
      observationEntry("obsentry1", "source01", [
        observation("bbbbbbbbbbbb", "first support"),
        observation("dddddddddddd", "required support"),
        observation("eeeeeeeeeeee", "new support"),
      ]),
      compaction("compact1", "kept0001", {
        type: "observational-memory",
        version: 5,
        generation: { inputFingerprint: "first" },
        reflectionsAdded: [first],
        observationsRetired: [],
        reflectionsSuperseded: [],
      }),
      source("kept0001"),
      compaction("compact2", "kept0002", {
        type: "observational-memory",
        version: 5,
        generation: { inputFingerprint: "invalid", parentMemoryCompactionId: "compact1" },
        reflectionsAdded: [invalidSuccessor],
        observationsRetired: [],
        reflectionsSuperseded: [{
          reflectionId: first.id,
          supersededByReflectionId: invalidSuccessor.id,
          reason: "strengthened",
        }],
      }),
      source("kept0002"),
    ]);

    expect(index.current.reflections).toEqual([first]);
    expect(index.reflectionById(invalidSuccessor.id)).toBeUndefined();
    expect(index.issues).toEqual([expect.objectContaining({
      entryId: "compact2",
      reason: "invalid-lifecycle-batch",
    })]);
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

  it("replays one parent-linked V6 lifecycle sequence across custom entries and compactions", () => {
    const firstObservation = observation("aaaaaaaaaaaa", "first", "2026-08-26T00:00:01.000Z");
    const secondObservation = observation("bbbbbbbbbbbb", "second", "2026-08-26T00:00:02.000Z");
    const firstReflection = reflection("cccccccccccc", "first reflection", [firstObservation.id]);
    const secondReflection = reflection("dddddddddddd", "second reflection", [secondObservation.id]);
    const entries: Entry[] = [
      observationEntry("obsentry1", "source01", [firstObservation]),
      compaction("compact1", "kept0001", {
        type: "observational-memory",
        version: 5,
        generation: { inputFingerprint: "v5-root" },
        reflectionsAdded: [],
        observationsRetired: [],
        reflectionsSuperseded: [],
      }),
      source("kept0001"),
      observationEntry("obsentry2", "source02", [secondObservation]),
      lifecycleV6("life0001", v6({
        fingerprint: "incremental",
        parentLifecycleEntryId: "compact1",
        frontier: { entryId: "obsentry1" },
        reflectionsAdded: [firstReflection],
      })),
      compaction("compact2", "kept0002", v6({
        fingerprint: "compaction",
        parentLifecycleEntryId: "life0001",
        frontier: { entryId: "obsentry2" },
        reflectionsAdded: [secondReflection],
      })),
      source("kept0002"),
    ];

    const index = buildBranchMemoryIndex(entries);

    expect(index.latestLifecycleEntryId).toBe("compact2");
    expect(index.reflectionProgress).toEqual({
      consideredThroughObservationEntryId: "obsentry2",
      compatibilityVersion: "reflection-v1",
    });
    expect(index.current.reflections).toEqual([firstReflection, secondReflection]);
    expect(index.issues).toEqual([]);
  });

  it("rejects stale parents and invalid frontiers atomically without changing the lifecycle head", () => {
    const firstObservation = observation("aaaaaaaaaaaa", "first", "2026-08-26T00:00:01.000Z");
    const secondObservation = observation("bbbbbbbbbbbb", "second", "2026-08-26T00:00:02.000Z");
    const validReflection = reflection("cccccccccccc", "valid", [firstObservation.id]);
    const rejectedReflection = reflection("dddddddddddd", "rejected", [secondObservation.id]);
    const base: Entry[] = [
      observationEntry("obsentry1", "source01", [firstObservation]),
      observationEntry("obsentry2", "source02", [secondObservation]),
      lifecycleV6("life0001", v6({
        fingerprint: "root",
        frontier: { entryId: "obsentry2" },
        reflectionsAdded: [validReflection],
      })),
    ];

    const stale = buildBranchMemoryIndex([
      ...base,
      lifecycleV6("life0002", v6({
        fingerprint: "stale",
        parentLifecycleEntryId: "missing-parent",
        frontier: { entryId: "obsentry2" },
        reflectionsAdded: [rejectedReflection],
      })),
    ]);
    expect(stale.latestLifecycleEntryId).toBe("life0001");
    expect(stale.reflectionById(rejectedReflection.id)).toBeUndefined();
    expect(stale.issues).toEqual([expect.objectContaining({ reason: "invalid-lifecycle-parent" })]);

    const backward = buildBranchMemoryIndex([
      ...base,
      lifecycleV6("life0002", v6({
        fingerprint: "backward",
        parentLifecycleEntryId: "life0001",
        frontier: { entryId: "obsentry1" },
        reflectionsAdded: [rejectedReflection],
      })),
    ]);
    expect(backward.latestLifecycleEntryId).toBe("life0001");
    expect(backward.reflectionById(rejectedReflection.id)).toBeUndefined();
    expect(backward.issues).toEqual([expect.objectContaining({ reason: "invalid-lifecycle-batch" })]);
  });

  it("derives V6 lifecycle state from the selected branch and rejects legacy authority after V6", () => {
    const committed = observation("aaaaaaaaaaaa", "committed", "2026-08-26T00:00:01.000Z");
    const added = reflection("bbbbbbbbbbbb", "incremental", [committed.id]);
    const beforeV6: Entry[] = [observationEntry("obsentry1", "source01", [committed])];
    const withV6: Entry[] = [
      ...beforeV6,
      lifecycleV6("life0001", v6({
        fingerprint: "root",
        frontier: { entryId: "obsentry1" },
        reflectionsAdded: [added],
      })),
    ];
    const withLegacyOverwrite: Entry[] = [
      ...withV6,
      compaction("compact1", "kept0001", details([committed], [])),
      source("kept0001"),
    ];

    expect(buildBranchMemoryIndex(beforeV6).latestLifecycleEntryId).toBeUndefined();
    expect(buildBranchMemoryIndex(beforeV6).current.reflections).toEqual([]);
    expect(buildBranchMemoryIndex(withV6).current.reflections).toEqual([added]);
    const replayed = buildBranchMemoryIndex(structuredClone(withLegacyOverwrite));
    expect(replayed.latestLifecycleEntryId).toBe("life0001");
    expect(replayed.current.reflections).toEqual([added]);
    expect(replayed.issues).toEqual([expect.objectContaining({
      entryId: "compact1",
      reason: "invalid-lifecycle-parent",
    })]);
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
