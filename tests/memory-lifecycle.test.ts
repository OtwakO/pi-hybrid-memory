import { describe, expect, it } from "vitest";

import {
  createMemoryLifecycleDetails,
  createMemoryLifecycleEvent,
} from "../src/om/memory-lifecycle.js";
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
      supersessions: [],
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
      supersessions: [],
    });

    expect(result.observationsRetired).toEqual([retirement]);
    expect(result).not.toHaveProperty("observations");
  });

  it("persists explicit reflection supersession edges", () => {
    const existing = reflection("bbbbbbbbbbbb", "durable reflection", [observation.id]);
    const successor = reflection("cccccccccccc", "durable reflection", [observation.id, "dddddddddddd"]);
    const supersession = {
      reflectionId: existing.id,
      supersededByReflectionId: successor.id,
      reason: "strengthened" as const,
    };

    const result = createMemoryLifecycleDetails({
      observations: [observation],
      previousReflections: [existing],
      currentReflections: [successor],
      retirements: [],
      supersessions: [supersession],
    });

    expect(result.reflectionsAdded).toEqual([successor]);
    expect(result.reflectionsSuperseded).toEqual([supersession]);
  });

  it("fingerprints the complete immutable input rather than ids alone", () => {
    const input = {
      observations: [observation],
      previousReflections: [],
      currentReflections: [],
      retirements: [],
      supersessions: [],
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
      supersessions: [],
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

  it("creates one minimal V6 event for compaction or custom-entry persistence", () => {
    const existing = reflection("bbbbbbbbbbbb", "existing");
    const added = reflection("cccccccccccc", "added");

    const result = createMemoryLifecycleEvent({
      parentLifecycleEntryId: "life0001",
      reflectionProgress: {
        consideredThroughObservationEntryId: "obsentry1",
        compatibilityVersion: "reflection-v1",
      },
      observations: [observation],
      previousReflections: [existing],
      currentReflections: [existing, added],
      retirements: [],
      supersessions: [],
    });

    expect(result).toMatchObject({
      type: "observational-memory",
      version: 6,
      generation: { parentLifecycleEntryId: "life0001" },
      reflectionProgress: {
        consideredThroughObservationEntryId: "obsentry1",
        compatibilityVersion: "reflection-v1",
      },
      reflectionsAdded: [added],
      observationsRetired: [],
      reflectionsSuperseded: [],
    });
    expect(result).not.toHaveProperty("observations");
    expect(result).not.toHaveProperty("reflections");
    expect(result.generation.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic for unchanged memory input", () => {
    const added = reflection("bbbbbbbbbbbb", "added");
    const input = {
      observations: [observation],
      previousReflections: [],
      currentReflections: [added],
      retirements: [],
      supersessions: [],
    };

    expect(createMemoryLifecycleDetails(input)).toEqual(createMemoryLifecycleDetails(input));
  });
});
