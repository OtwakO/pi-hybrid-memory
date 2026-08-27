import { describe, expect, it } from "vitest";

import {
  isProtocolProposal,
  validateProtocolProposal,
  type CompletionState,
  type ProtocolProposal,
  type RetirementProtocol,
} from "../evaluation/semantic-retirement/protocol.js";
import type { ObservationRecord } from "../src/types.js";

const observations: ObservationRecord[] = [{
  id: "aaaaaaaaaaaa",
  content: "PATH=/srv/app/config/runtime.json",
  timestamp: "2026-08-27T00:00:00Z",
  relevance: "critical",
  sourceEntryIds: ["1234abcd"],
}, {
  id: "bbbbbbbbbbbb",
  content: "Generated filler",
  timestamp: "2026-08-27T00:01:00Z",
  relevance: "low",
  sourceEntryIds: ["5678abcd"],
}];

const validProposal: ProtocolProposal = {
  reflections: [{
    proposalId: "r1",
    content: "The runtime config path is PATH=/srv/app/config/runtime.json",
    supportingObservationIds: [observations[0].id],
  }],
  retirements: [{
    observationId: observations[0].id,
    preservedByReflectionIds: ["r1"],
    reason: "fully-absorbed",
  }],
};

describe("semantic retirement protocol validation", () => {
  it("rejects malformed provider arguments before proposal validation", () => {
    expect(isProtocolProposal({
      reflections: [{ proposalId: "r1", content: "fact", supportingObservationIds: "not-an-array" }],
      retirements: [],
    })).toBe(false);
  });

  it.each(["combined", "separate"] as const)("validates an explicit %s proposal", (protocol) => {
    const result = validateProtocolProposal({
      protocol,
      observations,
      proposal: validProposal,
      completionState: "success",
    });

    expect(result).toMatchObject({
      valid: true,
      issues: [],
      activeObservations: [observations[1]],
      retiredObservationIds: [observations[0].id],
      currentReflections: [{
        content: validProposal.reflections[0].content,
        supportingObservationIds: [observations[0].id],
      }],
    });
  });

  it.each([
    ["combined", "truncated", validProposal, "completion-truncated"],
    ["separate", "error", validProposal, "completion-error"],
    ["combined", "success", {
      ...validProposal,
      reflections: [{ ...validProposal.reflections[0], supportingObservationIds: ["unknown"] }],
    }, "invalid-reflection-support"],
    ["separate", "success", {
      ...validProposal,
      retirements: [{ ...validProposal.retirements[0], preservedByReflectionIds: ["missing"] }],
    }, "invalid-retirement-preservation"],
    ["combined", "success", {
      ...validProposal,
      retirements: [validProposal.retirements[0], validProposal.retirements[0]],
    }, "duplicate-retirement-target"],
  ] satisfies Array<[RetirementProtocol, CompletionState, ProtocolProposal, string]>) (
    "fails closed for %s %s output",
    (protocol, completionState, proposal, expectedIssue) => {
      const result = validateProtocolProposal({ protocol, observations, proposal, completionState });

      expect(result.valid).toBe(false);
      expect(result.issues).toContain(expectedIssue);
      expect(result.activeObservations).toEqual(observations);
      expect(result.currentReflections).toEqual([]);
      expect(result.retiredObservationIds).toEqual([]);
    },
  );
});
