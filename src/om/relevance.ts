// Relevance histogram — ported from pi-observational-memory
import type { ObservationRecord, Relevance } from "../types.js";

export const countByRelevance = (observations: ObservationRecord[]): Record<Relevance, number> => {
  const result: Record<Relevance, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const obs of observations) result[obs.relevance]++;
  return result;
};

const HISTOGRAM_SYMBOLS: Record<Relevance, string> = {
  low: "·",
  medium: "•",
  high: "◦",
  critical: "●",
};

export const formatRelevanceHistogram = (histogram: Record<Relevance, number>): string => {
  const parts: string[] = [];
  for (const level of ["low", "medium", "high", "critical"] as Relevance[]) {
    const count = histogram[level];
    if (count === 0) continue;
    parts.push(`${HISTOGRAM_SYMBOLS[level]}${count}`);
  }
  return parts.join("  ") || "(none)";
};
