import { createHash } from "node:crypto";

import type { MemoryReflection, ObservationRecord } from "../../src/types.js";

export type RetirementProtocol = "combined" | "separate";

export interface ProposedReflection {
  proposalId: string;
  content: string;
  supportingObservationIds: string[];
}

export interface ProposedRetirement {
  observationId: string;
  preservedByReflectionIds: string[];
  reason: "fully-absorbed";
}

export interface ProtocolProposal {
  reflections: ProposedReflection[];
  retirements: ProposedRetirement[];
}

export interface ProtocolValidationResult {
  valid: boolean;
  issues: string[];
  activeObservations: ObservationRecord[];
  currentReflections: MemoryReflection[];
  retiredObservationIds: string[];
}

export type CompletionState = "success" | "truncated" | "error" | "aborted" | "invalid-output";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === "string");

export const isProposedReflection = (value: unknown): value is ProposedReflection => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ["proposalId", "content", "supportingObservationIds"].includes(key))
    && typeof item.proposalId === "string"
    && typeof item.content === "string"
    && isStringArray(item.supportingObservationIds);
};

export const isProposedRetirement = (value: unknown): value is ProposedRetirement => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ["observationId", "preservedByReflectionIds", "reason"].includes(key))
    && typeof item.observationId === "string"
    && isStringArray(item.preservedByReflectionIds)
    && item.reason === "fully-absorbed";
};

export const isProtocolProposal = (value: unknown): value is ProtocolProposal => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proposal = value as Record<string, unknown>;
  return Object.keys(proposal).every(key => key === "reflections" || key === "retirements")
    && Array.isArray(proposal.reflections)
    && proposal.reflections.every(isProposedReflection)
    && Array.isArray(proposal.retirements)
    && proposal.retirements.every(isProposedRetirement);
};

const evaluationReflectionId = (
  protocol: RetirementProtocol,
  proposal: ProposedReflection,
  index: number,
): string => createHash("sha256")
  .update(`${protocol}\u0000${index}\u0000${proposal.proposalId}\u0000${proposal.content}`)
  .digest("hex")
  .slice(0, 12);

export const validateProtocolProposal = (input: {
  protocol: RetirementProtocol;
  observations: readonly ObservationRecord[];
  proposal: ProtocolProposal;
  completionState: CompletionState;
}): ProtocolValidationResult => {
  const observationsById = new Map(input.observations.map(observation => [observation.id, observation]));
  const issues: string[] = [];
  if (input.completionState !== "success") {
    return {
      valid: false,
      issues: [`completion-${input.completionState}`],
      activeObservations: [...input.observations],
      currentReflections: [],
      retiredObservationIds: [],
    };
  }

  const proposalIds = new Set<string>();
  for (const reflection of input.proposal.reflections) {
    if (!reflection.proposalId.trim() || proposalIds.has(reflection.proposalId)) {
      issues.push("invalid-reflection-proposal-id");
    }
    proposalIds.add(reflection.proposalId);
    if (!reflection.content.trim()) issues.push("empty-reflection-content");
    if (
      reflection.supportingObservationIds.length === 0
      || new Set(reflection.supportingObservationIds).size !== reflection.supportingObservationIds.length
      || reflection.supportingObservationIds.some(id => !observationsById.has(id))
    ) issues.push("invalid-reflection-support");
  }

  const reflectionByProposalId = new Map(input.proposal.reflections.map(reflection => [reflection.proposalId, reflection]));
  const retiredIds = new Set<string>();
  for (const retirement of input.proposal.retirements) {
    if (!observationsById.has(retirement.observationId)) issues.push("unknown-retirement-target");
    if (retiredIds.has(retirement.observationId)) issues.push("duplicate-retirement-target");
    retiredIds.add(retirement.observationId);
    if (
      retirement.preservedByReflectionIds.length === 0
      || new Set(retirement.preservedByReflectionIds).size !== retirement.preservedByReflectionIds.length
      || retirement.preservedByReflectionIds.some(id => {
        const reflection = reflectionByProposalId.get(id);
        return !reflection || !reflection.supportingObservationIds.includes(retirement.observationId);
      })
    ) issues.push("invalid-retirement-preservation");
  }

  if (issues.length > 0) {
    return {
      valid: false,
      issues: [...new Set(issues)],
      activeObservations: [...input.observations],
      currentReflections: [],
      retiredObservationIds: [],
    };
  }

  const currentReflections = input.proposal.reflections.map((reflection, index) => ({
    id: evaluationReflectionId(input.protocol, reflection, index),
    content: reflection.content.trim(),
    supportingObservationIds: [...reflection.supportingObservationIds],
  }));
  const retiredObservationIds = [...retiredIds];
  return {
    valid: true,
    issues: [],
    activeObservations: input.observations.filter(observation => !retiredIds.has(observation.id)),
    currentReflections,
    retiredObservationIds,
  };
};
