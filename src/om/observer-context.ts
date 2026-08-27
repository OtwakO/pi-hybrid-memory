import type { Model } from "@earendil-works/pi-ai";

export const OBSERVER_PROMPT_VERSION = "observer-v6-bounded-context";
export const OBSERVER_TOOL_VERSION = "record-observations-v5-native";
export const OBSERVER_SERIALIZER_VERSION = "source-segments-v2";

// Conservative allowance for observer output, tool schemas, provider framing,
// and one bounded correction turn. Both observer paths must use one value.
export const OBSERVER_FIXED_TOKEN_RESERVE = 6_144;
export const OBSERVER_MINIMUM_DELTA_TOKENS = 256;

export const OBSERVER_DELTA_INSTRUCTIONS = [
  "Submit the complete set of durable observations for this source chunk through record_observations.",
  "Do not restate facts already visible in the bounded baseline, source-related history, or committed epoch transcript.",
  "Use an empty observations array when this chunk contains nothing durable.",
].join("\n");

export const observerDeltaText = (
  chunk: string,
  sourceEntryIds: readonly string[],
  sourceRelatedText = "",
): string => [
  OBSERVER_DELTA_INSTRUCTIONS,
  ...(sourceRelatedText.trim() ? ["", sourceRelatedText.trim()] : []),
  "",
  `Valid sourceEntryIds for this chunk: ${sourceEntryIds.join(", ")}`,
  "If sourceEntryIds is supplied, use only IDs from that exact list. Do not cite source IDs from historical context.",
  "Omit sourceEntryIds when an observation depends on the full current chunk.",
  "",
  chunk.trim(),
].join("\n");

export const observerCompatibilityKey = (model: Model<any>): string => [
  model.provider,
  model.api,
  model.id,
  OBSERVER_PROMPT_VERSION,
  OBSERVER_TOOL_VERSION,
  OBSERVER_SERIALIZER_VERSION,
].join("|");

export const observerEpochTokenLimit = (
  model: Model<any>,
  configuredMaxTokens: number,
): number => Math.max(4096, Math.min(configuredMaxTokens, Math.floor(model.contextWindow * 0.4)));
