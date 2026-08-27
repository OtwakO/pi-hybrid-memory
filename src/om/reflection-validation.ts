import type { MemoryReflection, ObservationRecord, ReflectionRecord, ReflectionSupersession } from "../types.js";
import { MAX_REFLECTION_CONTENT_CHARS } from "./reflection-budget.js";

let idCounter = 0;

const makeId = (): string => {
  idCounter++;
  return `${Date.now().toString(36).slice(-8)}${idCounter.toString(36).padStart(4, "0")}`;
};

const reflectionContent = (reflection: MemoryReflection): string =>
  typeof reflection === "string" ? reflection : reflection.content;

const normalizedReflectionKey = (content: string): string => content.trim().replace(/\s+/g, " ");

export interface ReflectionProposalItem {
  content: string;
  supportingObservationIds: string[];
}

export type ReflectionValidationResult =
  | {
      ok: true;
      reflections: MemoryReflection[];
      proposedItems: number;
      acceptedItems: number;
      addedItems: number;
      strengthenedItems: number;
       supportedObservationIds: string[];
       supersessions: ReflectionSupersession[];
    }
  | { ok: false; reason: "invalid-output" | "invalid-provenance" };

/** Validate semantic provenance locally, then merge without mutating inputs. */
export const validateAndMergeReflections = (
  existingReflections: readonly MemoryReflection[],
  observations: readonly ObservationRecord[],
  proposal: readonly ReflectionProposalItem[],
): ReflectionValidationResult => {
  const activeObservationIds = new Set(observations.map((observation) => observation.id));
  for (const candidate of proposal) {
    if (
      typeof candidate.content !== "string"
      || !candidate.content.trim()
      || candidate.content.length > MAX_REFLECTION_CONTENT_CHARS
    ) {
      return { ok: false, reason: "invalid-output" };
    }
    const supportingIds = candidate.supportingObservationIds;
    if (
      !Array.isArray(supportingIds)
      || supportingIds.length === 0
      || supportingIds.some((id) => typeof id !== "string" || !activeObservationIds.has(id))
      || new Set(supportingIds).size !== supportingIds.length
    ) {
      return { ok: false, reason: "invalid-provenance" };
    }
  }

  const merged: MemoryReflection[] = [...existingReflections];
  const contentIndex = new Map<string, number>();
  for (let index = 0; index < existingReflections.length; index++) {
    contentIndex.set(normalizedReflectionKey(reflectionContent(existingReflections[index])), index);
  }

  let addedItems = 0;
  let strengthenedItems = 0;
  const supportedObservationIds = new Set<string>();
  const proposedSupportByExistingIndex = new Map<number, Set<string>>();
  for (const candidate of proposal) {
    const content = candidate.content.trim();
    const supportingObservationIds = [...candidate.supportingObservationIds];
    for (const id of supportingObservationIds) supportedObservationIds.add(id);

    const key = normalizedReflectionKey(content);
    const existingIndex = contentIndex.get(key);
    if (existingIndex === undefined) {
      merged.push({ id: makeId(), content, supportingObservationIds });
      contentIndex.set(key, merged.length - 1);
      addedItems++;
      continue;
    }

    const existing = merged[existingIndex];
    if (typeof existing === "string") continue;
    const support = proposedSupportByExistingIndex.get(existingIndex)
      ?? new Set(existing.supportingObservationIds);
    for (const id of supportingObservationIds) support.add(id);
    proposedSupportByExistingIndex.set(existingIndex, support);
  }

  const supersessions: ReflectionSupersession[] = [];
  for (const [existingIndex, support] of proposedSupportByExistingIndex) {
    const existing = merged[existingIndex] as ReflectionRecord;
    if (support.size === existing.supportingObservationIds.length) continue;
    const successor: ReflectionRecord = {
      id: makeId(),
      content: existing.content,
      supportingObservationIds: [...support],
      ...(existing.legacy ? { legacy: true } : {}),
    };
    merged[existingIndex] = successor;
    supersessions.push({
      reflectionId: existing.id,
      supersededByReflectionId: successor.id,
      reason: "strengthened",
    });
    strengthenedItems++;
  }

  return {
    ok: true,
    reflections: merged,
    proposedItems: proposal.length,
    acceptedItems: addedItems + strengthenedItems,
    addedItems,
    strengthenedItems,
    supportedObservationIds: [...supportedObservationIds],
    supersessions,
  };
};
