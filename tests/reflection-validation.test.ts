import { describe, expect, it } from "vitest";
import { validateAndMergeReflections } from "../src/om/reflection-validation.js";
import type { MemoryReflection, ObservationRecord } from "../src/types.js";

const observation: ObservationRecord = {
  id: "aaaaaaaaaaaa",
  content: "durable fact",
  timestamp: "2026-01-01 00:00",
  relevance: "high",
};

describe("validateAndMergeReflections", () => {
  it("rejects unknown and duplicate support ids", () => {
    expect(validateAndMergeReflections([], [observation], [{
      content: "unknown support",
      supportingObservationIds: ["bbbbbbbbbbbb"],
    }])).toEqual({ ok: false, reason: "invalid-provenance" });

    expect(validateAndMergeReflections([], [observation], [{
      content: "duplicate support",
      supportingObservationIds: [observation.id, observation.id],
    }])).toEqual({ ok: false, reason: "invalid-provenance" });
  });

  it("keeps an existing reflection revision immutable when extra support is proposed", () => {
    const existing: MemoryReflection[] = [{
      id: "bbbbbbbbbbbb",
      content: "durable reflection",
      supportingObservationIds: [],
    }];

    const result = validateAndMergeReflections(existing, [observation], [{
      content: "durable reflection",
      supportingObservationIds: [observation.id],
    }]);

    expect(result).toMatchObject({
      ok: true,
      proposedItems: 1,
      acceptedItems: 0,
      addedItems: 0,
      strengthenedItems: 0,
      supportedObservationIds: [observation.id],
      reflections: [{
        id: "bbbbbbbbbbbb",
        supportingObservationIds: [],
      }],
    });
    expect(existing[0]).toEqual({
      id: "bbbbbbbbbbbb",
      content: "durable reflection",
      supportingObservationIds: [],
    });
  });

  it("reports a duplicate proposal as proposed but not accepted", () => {
    const existing: MemoryReflection[] = [{
      id: "bbbbbbbbbbbb",
      content: "durable reflection",
      supportingObservationIds: [observation.id],
    }];

    const result = validateAndMergeReflections(existing, [observation], [{
      content: " durable   reflection ",
      supportingObservationIds: [observation.id],
    }]);

    expect(result).toMatchObject({
      ok: true,
      proposedItems: 1,
      acceptedItems: 0,
      addedItems: 0,
      strengthenedItems: 0,
    });
  });
});
