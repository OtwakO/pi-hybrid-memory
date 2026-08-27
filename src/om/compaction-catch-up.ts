import type { Entry } from "../types.js";
import type { SourceAddressedSerialization } from "./serialize.js";

export type CatchUpProgress =
  | { complete: true; coveredUpToId: string }
  | { complete: false; coveredUpToId: string; remainingEntries: Entry[] };

export const catchUpProgress = (
  remainingEntries: Entry[],
  previousCoverageId: string,
  serialization: SourceAddressedSerialization,
): CatchUpProgress => {
  const coveredUpToId = serialization.coversUpToId ?? previousCoverageId;
  if (serialization.completedSourceEntryIds.length === 0) {
    return { complete: false, coveredUpToId, remainingEntries };
  }

  const coveredIndex = remainingEntries.findIndex(entry => entry.id === coveredUpToId);
  if (coveredIndex < 0) {
    throw new Error(`observer coverage marker ${coveredUpToId} was not found in the remaining gap`);
  }
  const remaining = remainingEntries.slice(coveredIndex + 1);
  return remaining.length === 0 && !serialization.sourceProgress
    ? { complete: true, coveredUpToId }
    : { complete: false, coveredUpToId, remainingEntries: remaining };
};
