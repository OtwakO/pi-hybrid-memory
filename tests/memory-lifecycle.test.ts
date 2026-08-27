import { describe, expect, it } from "vitest";

import { createMemoryLifecycleDetails } from "../src/om/memory-lifecycle.js";
import type { ObservationRecord, ReflectionRecord } from "../src/types.js";

const observation: ObservationRecord = {
  id: "aaaaaaaaaaaa",
  content: "durable fact",
  timestamp: "2026-08-26T00:00:00.000Z",
  relevance: "high",
};

const reflection = (
  id: string,
  content: string,
  supportingObservationIds = [observation.id],
): ReflectionRecord => ({ id, content, supportingObservationIds });

describe("memory lifecycle details", () => {
  it("persists only newly added reflection revisions", () => {
    const existing = reflection("bbbbbbbbbbbb", "existing");
    const added = reflection("cccccccccccc", "added");

    const result = createMemoryLifecycleDetails({
      parentMemoryCompactionId: "compact1",
      observations: [observation],
      previousReflections: [existing],
      currentReflections: [existing, added],
      retirements: [],
    });

    expect(result).toMatchObject({
      type: "observational-memory",
      version: 5,
      generation: { parentMemoryCompactionId: "compact1" },
      reflectionsAdded: [added],
      observationsRetired: [],
      reflectionsSuperseded: [],
    });
    expect(result).not.toHaveProperty("observations");
    expect(result).not.toHaveProperty("reflections");
    expect(result.generation.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("persists explicit retirement events without copying observation evidence", () => {
    const retirement = {
      observationId: "bbbbbbbbbbbb",
      reason: "exact-duplicate" as const,
      preservedByObservationIds: [observation.id] as [string],
      preservedByReflectionIds: [] as [],
    };

    const result = createMemoryLifecycleDetails({
      observations: [observation],
      previousReflections: [],
      currentReflections: [],
      retirements: [retirement],
    });

    expect(result.observationsRetired).toEqual([retirement]);
    expect(result).not.toHaveProperty("observations");
  });

  it("fingerprints the complete immutable input rather than ids alone", () => {
    const input = {
      observations: [observation],
      previousReflections: [],
      currentReflections: [],
      retirements: [],
    };
    const changed = {
      ...input,
      observations: [{ ...observation, content: "changed payload" }],
    };

    expect(createMemoryLifecycleDetails(input).generation.inputFingerprint).not.toBe(
      createMemoryLifecycleDetails(changed).generation.inputFingerprint,
    );
  });

  it("distinguishes legacy reflection text and the legacy record flag", () => {
    const base = {
      observations: [observation],
      currentReflections: [],
      retirements: [],
    };
    const legacyString = createMemoryLifecycleDetails({
      ...base,
      previousReflections: ["legacy one"],
    }).generation.inputFingerprint;
    const changedLegacyString = createMemoryLifecycleDetails({
      ...base,
      previousReflections: ["legacy two"],
    }).generation.inputFingerprint;
    const record = reflection("bbbbbbbbbbbb", "record");
    const normalRecord = createMemoryLifecycleDetails({
      ...base,
      previousReflections: [record],
    }).generation.inputFingerprint;
    const legacyRecord = createMemoryLifecycleDetails({
      ...base,
      previousReflections: [{ ...record, legacy: true }],
    }).generation.inputFingerprint;

    expect(legacyString).not.toBe(changedLegacyString);
    expect(normalRecord).not.toBe(legacyRecord);
  });

  it("is deterministic for unchanged memory input", () => {
    const added = reflection("bbbbbbbbbbbb", "added");
    const input = {
      observations: [observation],
      previousReflections: [],
      currentReflections: [added],
      retirements: [],
    };

    expect(createMemoryLifecycleDetails(input)).toEqual(createMemoryLifecycleDetails(input));
  });
});
