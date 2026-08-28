import { describe, expect, it } from "vitest";

import { resolveReflectionHandles } from "../src/om/reflection-handle-resolution.js";

const handleMap = {
  E001: "observation01",
  E002: "observation02",
  E003: "observation03",
};

describe("reflection evidence handle resolution", () => {
  it("maps valid local handles to canonical observation ids", () => {
    const result = resolveReflectionHandles([
      { content: " durable conclusion ", supportingEvidenceHandles: ["E001", "E003"] },
    ], handleMap);

    expect(result).toEqual({
      proposedItems: 1,
      rejectedItems: 0,
      candidates: [{
        content: "durable conclusion",
        supportingObservationIds: ["observation01", "observation03"],
      }],
    });
  });

  it("rejects an invalid candidate without discarding unrelated valid candidates", () => {
    const result = resolveReflectionHandles([
      { content: "valid first", supportingEvidenceHandles: ["E001"] },
      { content: "unknown support", supportingEvidenceHandles: ["E999"] },
      { content: "valid second", supportingEvidenceHandles: ["E002", "E003"] },
    ], handleMap);

    expect(result).toEqual({
      proposedItems: 3,
      rejectedItems: 1,
      candidates: [
        { content: "valid first", supportingObservationIds: ["observation01"] },
        { content: "valid second", supportingObservationIds: ["observation02", "observation03"] },
      ],
    });
  });

  it.each([
    { content: "", supportingEvidenceHandles: ["E001"] },
    { content: "valid", supportingEvidenceHandles: [] },
    { content: "valid", supportingEvidenceHandles: ["E001", "E001"] },
  ])("rejects malformed candidate %# without repairing it", candidate => {
    const result = resolveReflectionHandles([candidate], handleMap);

    expect(result).toEqual({ proposedItems: 1, rejectedItems: 1, candidates: [] });
  });
});
