import { createHash } from "node:crypto";

import { reflectionContent } from "../../src/om/compaction.js";
import { estimateStringTokens } from "../../src/om/tokens.js";
import type { MemoryReflection, ObservationRecord } from "../../src/types.js";

export type RequiredFactDisposition = "must-retain" | "retirable-if-exactly-preserved";

export interface RequiredFact {
  observationId: string;
  requiredMarker: string;
  expectedSourceIds: string[];
  disposition: RequiredFactDisposition;
}

export interface MemoryQualityFixture {
  observations: ObservationRecord[];
  requiredFacts: RequiredFact[];
}

export interface MemoryQualityCandidate {
  activeObservations: ObservationRecord[];
  currentReflections: MemoryReflection[];
  retiredObservationIds: string[];
}

export interface MemoryQualityReport {
  valid: boolean;
  issues: string[];
  failedRequiredFactIds: string[];
  falseRetirementIds: string[];
  falseRetentionIds: string[];
  missingProvenanceIds: string[];
  baselineTokens: number;
  activeTokens: number;
  reducedTokens: number;
  reductionPercentage: number;
  fingerprint: string;
}

const memoryTokens = (
  observations: readonly ObservationRecord[],
  reflections: readonly MemoryReflection[],
): number => observations.reduce((sum, item) => sum + estimateStringTokens(item.content), 0)
  + reflections.reduce((sum, item) => sum + estimateStringTokens(reflectionContent(item)), 0);

const projectionFingerprint = (
  activeObservationIds: readonly string[],
  retiredObservationIds: readonly string[],
  reflections: readonly MemoryReflection[],
): string => createHash("sha256").update(JSON.stringify({
  activeObservationIds,
  retiredObservationIds,
  reflections,
})).digest("hex");

export const evaluateMemoryQuality = (
  fixture: MemoryQualityFixture,
  candidate: MemoryQualityCandidate,
): MemoryQualityReport => {
  const evidenceById = new Map(fixture.observations.map(observation => [observation.id, observation]));
  const activeIds = candidate.activeObservations.map(observation => observation.id);
  const retiredIds = candidate.retiredObservationIds;
  const issues: string[] = [];
  const activeSet = new Set(activeIds);
  const retiredSet = new Set(retiredIds);

  if (activeSet.size !== activeIds.length) issues.push("duplicate-active-observation-id");
  if (retiredSet.size !== retiredIds.length) issues.push("duplicate-retired-observation-id");
  if (activeIds.some(id => retiredSet.has(id))) issues.push("active-retired-overlap");
  if (activeIds.some(id => !evidenceById.has(id))) issues.push("unknown-active-observation-id");
  if (retiredIds.some(id => !evidenceById.has(id))) issues.push("unknown-retired-observation-id");
  if (fixture.observations.some(observation => !activeSet.has(observation.id) && !retiredSet.has(observation.id))) {
    issues.push("unclassified-observation-id");
  }
  if (candidate.activeObservations.some(observation => {
    const evidence = evidenceById.get(observation.id);
    return evidence !== undefined && JSON.stringify(evidence) !== JSON.stringify(observation);
  })) issues.push("mutated-active-observation");

  const reflectionIds = new Set<string>();
  for (const reflection of candidate.currentReflections) {
    if (typeof reflection === "string") continue;
    if (reflectionIds.has(reflection.id)) issues.push("duplicate-reflection-id");
    reflectionIds.add(reflection.id);
    if (reflection.supportingObservationIds.some(id => !evidenceById.has(id))) {
      issues.push("unknown-reflection-support-id");
    }
  }

  const preserves = (fact: RequiredFact): boolean => {
    if (activeSet.has(fact.observationId)) return true;
    if (fact.disposition === "must-retain") return false;
    return candidate.currentReflections.some(reflection =>
      typeof reflection !== "string"
      && reflection.supportingObservationIds.includes(fact.observationId)
      && reflection.content.includes(fact.requiredMarker));
  };

  const failedRequiredFactIds = fixture.requiredFacts
    .filter(fact => !preserves(fact))
    .map(fact => fact.observationId);
  const falseRetirementIds = fixture.requiredFacts
    .filter(fact => retiredSet.has(fact.observationId)
      && (fact.disposition === "must-retain" || !preserves(fact)))
    .map(fact => fact.observationId);
  const falseRetentionIds = fixture.requiredFacts
    .filter(fact => fact.disposition === "retirable-if-exactly-preserved"
      && activeSet.has(fact.observationId)
      && candidate.currentReflections.some(reflection =>
        typeof reflection !== "string"
        && reflection.supportingObservationIds.includes(fact.observationId)
        && reflection.content.includes(fact.requiredMarker)))
    .map(fact => fact.observationId);
  const missingProvenanceIds = fixture.requiredFacts
    .filter(fact => {
      const observation = evidenceById.get(fact.observationId);
      return !observation || fact.expectedSourceIds.some(id => !observation.sourceEntryIds?.includes(id));
    })
    .map(fact => fact.observationId);

  const baselineTokens = memoryTokens(fixture.observations, []);
  const activeTokens = memoryTokens(candidate.activeObservations, candidate.currentReflections);
  const reducedTokens = Math.max(0, baselineTokens - activeTokens);
  const reductionPercentage = baselineTokens === 0 ? 0 : reducedTokens / baselineTokens * 100;

  return {
    valid: issues.length === 0,
    issues: [...new Set(issues)],
    failedRequiredFactIds,
    falseRetirementIds,
    falseRetentionIds,
    missingProvenanceIds,
    baselineTokens,
    activeTokens,
    reducedTokens,
    reductionPercentage,
    fingerprint: projectionFingerprint(activeIds, retiredIds, candidate.currentReflections),
  };
};
