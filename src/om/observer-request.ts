import type { Entry, SourceProgress } from "../types.js";
import { observerDeltaText } from "./observer-context.js";
import {
  estimateFreshObserverEpochTokens,
  type FreshEpochCapacity,
  type ObserverEpochManager,
  type PreparedObserverEpoch,
} from "./observer-epoch.js";
import {
  serializeSourceAddressedBranchEntries,
  type SourceAddressedSerialization,
} from "./serialize.js";
import { estimateStringTokens } from "./tokens.js";

export interface ObserverSourceRequestInput {
  epoch: ObserverEpochManager;
  compatibilityKey: string;
  expectedCoverageId: string;
  baselineText: string;
  entries: Entry[];
  sourceProgress?: SourceProgress;
  maxTokens: number;
  sourceMaxTokens: number;
  fixedTokens: number;
  minimumSourceTokens: number;
}

export type ObserverSourceRequestResult =
  | {
      ok: true;
      serialized: SourceAddressedSerialization;
      prepared: PreparedObserverEpoch;
      capacity: FreshEpochCapacity;
    }
  | {
      ok: false;
      reason: "insufficient-source-capacity";
      capacity: FreshEpochCapacity;
    };

const candidateRequest = (
  input: ObserverSourceRequestInput,
  sourceTokens: number,
): {
  serialized: SourceAddressedSerialization;
  deltaText: string;
  projectedTokens: number;
} | undefined => {
  const serialized = serializeSourceAddressedBranchEntries(
    input.entries,
    sourceTokens,
    input.sourceProgress,
  );
  if (!serialized.text.trim() || serialized.sourceEntryIds.length === 0) return undefined;
  const deltaText = observerDeltaText(serialized.text, serialized.sourceEntryIds);
  return {
    serialized,
    deltaText,
    projectedTokens: estimateFreshObserverEpochTokens(
      input.baselineText,
      deltaText,
      input.fixedTokens,
    ),
  };
};

export const prepareObserverSourceRequest = (
  input: ObserverSourceRequestInput,
): ObserverSourceRequestResult => {
  const maximumSourceTokens = Math.max(0, Math.floor(input.sourceMaxTokens));
  let lower = 0;
  let upper = maximumSourceTokens;
  let selected: ReturnType<typeof candidateRequest>;
  let availableSourceTokens = 0;

  while (lower <= upper) {
    const sourceTokens = Math.floor((lower + upper) / 2);
    const candidate = candidateRequest(input, sourceTokens);
    if (candidate && candidate.projectedTokens <= input.maxTokens) {
      selected = candidate;
      availableSourceTokens = sourceTokens;
      lower = sourceTokens + 1;
    } else {
      upper = sourceTokens - 1;
    }
  }

  const selectedSourceTokens = selected
    ? estimateStringTokens(selected.serialized.text)
    : 0;
  const madeCompleteSourceProgress = (selected?.serialized.completedSourceEntryIds.length ?? 0) > 0;
  const capacity: FreshEpochCapacity = {
    occupiedTokens: Math.max(0, input.maxTokens - availableSourceTokens),
    availableDeltaTokens: availableSourceTokens,
    maxTokens: input.maxTokens,
    minimumDeltaTokens: input.minimumSourceTokens,
    pressured: !madeCompleteSourceProgress && selectedSourceTokens < input.minimumSourceTokens,
  };
  if (!selected || capacity.pressured) {
    return { ok: false, reason: "insufficient-source-capacity", capacity };
  }

  const prepared = input.epoch.prepare({
    compatibilityKey: input.compatibilityKey,
    expectedCoverageId: input.expectedCoverageId,
    baselineText: input.baselineText,
    deltaText: selected.deltaText,
    maxTokens: input.maxTokens,
    fixedTokens: input.fixedTokens,
  });
  if (!prepared.ok) {
    return { ok: false, reason: "insufficient-source-capacity", capacity };
  }

  return { ok: true, serialized: selected.serialized, prepared, capacity };
};
