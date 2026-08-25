// Reflection coverage utilities and memory rendering.
import type { MemoryReflection, ObservationRecord } from "../types.js";
import { observationsToPromptLines } from "./observer.js";

export const reflectionContent = (reflection: MemoryReflection): string =>
  typeof reflection === "string" ? reflection : reflection.content;

export type ObservationCoverageTag = "uncited" | "cited" | "reinforced";

/** Count how many provenance-backed reflections cite each observation. */
export function deriveCoverageTags(
  reflections: MemoryReflection[],
  observations: ObservationRecord[],
): Map<string, ObservationCoverageTag> {
  const activeIds = new Set(observations.map((observation) => observation.id));
  const counts = new Map<string, number>();
  for (const observation of observations) counts.set(observation.id, 0);

  for (const reflection of reflections) {
    if (typeof reflection === "string" || reflection.legacy) continue;
    const cited = reflection.supportingObservationIds.filter((id) => activeIds.has(id));
    for (const id of cited) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const tags = new Map<string, ObservationCoverageTag>();
  for (const observation of observations) {
    const count = counts.get(observation.id) ?? 0;
    tags.set(observation.id, count === 0 ? "uncited" : count >= 4 ? "reinforced" : "cited");
  }
  return tags;
}

export const renderSummary = (
  reflections: MemoryReflection[],
  observations: ObservationRecord[],
): string => {
  const parts: string[] = [];
  if (reflections.length > 0) {
    parts.push("Reflections:");
    for (const reflection of reflections) {
      if (typeof reflection === "string") parts.push(`- ${reflection}`);
      else parts.push(`- [${reflection.id}] ${reflection.content}`);
    }
  }
  if (observations.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push("Observations:");
    parts.push(observationsToPromptLines(observations).join("\n"));
  }
  return parts.join("\n");
};
