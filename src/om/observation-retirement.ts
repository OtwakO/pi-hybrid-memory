import type { ObservationRecord, ObservationRetirement } from "../types.js";

export interface ExactDuplicateRetirementPlan {
  activeObservations: ObservationRecord[];
  retirements: ObservationRetirement[];
}

export const normalizedObservationContent = (content: string): string =>
  content.replace(/\r\n?/g, "\n").trim();

const duplicateKey = (observation: ObservationRecord): string =>
  `${observation.relevance}\u0000${normalizedObservationContent(observation.content)}`;

export const areExactDuplicateObservations = (
  left: ObservationRecord,
  right: ObservationRecord,
): boolean => left.relevance === right.relevance
  && normalizedObservationContent(left.content) === normalizedObservationContent(right.content);

export const planExactDuplicateRetirements = (
  observations: readonly ObservationRecord[],
  canonicalObservationIds: ReadonlySet<string>,
): ExactDuplicateRetirementPlan => {
  const representatives = new Map<string, ObservationRecord>();
  const activeObservations: ObservationRecord[] = [];
  const retirements: ObservationRetirement[] = [];

  for (const observation of observations) {
    const key = duplicateKey(observation);
    const representative = representatives.get(key);
    if (!representative || !canonicalObservationIds.has(observation.id)) {
      if (!representative) representatives.set(key, observation);
      activeObservations.push(observation);
      continue;
    }

    retirements.push({
      observationId: observation.id,
      reason: "exact-duplicate",
      preservedByObservationIds: [representative.id],
      preservedByReflectionIds: [],
    });
  }

  return { activeObservations, retirements };
};
