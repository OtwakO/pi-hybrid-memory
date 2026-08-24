import type { Model } from "@mariozechner/pi-ai";
import type { MemoryReflection, ObservationRecord } from "../types.js";
import { reflectionContent } from "./compaction.js";
import { observationsToPromptLines } from "./observer.js";

export const OBSERVER_PROMPT_VERSION = "observer-v2-epoch";
export const OBSERVER_TOOL_VERSION = "record-observations-v1";
export const OBSERVER_SERIALIZER_VERSION = "source-addressed-v1";

// Conservative allowance for observer output, tool schemas, provider framing,
// and the final tool-continuation turn. Both observer paths must use one value.
export const OBSERVER_FIXED_TOKEN_RESERVE = 6_144;

const joinOrEmpty = (items: string[]): string => items.length ? items.join("\n") : "(none yet)";

export const observerBaselineText = (
  reflections: readonly MemoryReflection[],
  observations: readonly ObservationRecord[],
): string => [
  "This is the immutable memory baseline for the current observer epoch.",
  "Use it to avoid duplicates and preserve corrections. Later source chunks and recorded observations appear chronologically after this baseline.",
  "",
  `CURRENT REFLECTIONS:\n${joinOrEmpty(reflections.map((reflection) => reflectionContent(reflection)))}`,
  "",
  `CURRENT OBSERVATIONS:\n${joinOrEmpty(observationsToPromptLines([...observations]))}`,
].join("\n");

export const OBSERVER_DELTA_INSTRUCTIONS = [
  "Compress this new conversation chunk into observations by calling record_observations one or more times.",
  "Do not restate facts already visible in the immutable baseline or committed epoch transcript.",
  "Stop calling the tool and reply with a short plain-text confirmation once this chunk is fully covered.",
].join("\n");

export const observerDeltaText = (chunk: string): string => [
  OBSERVER_DELTA_INSTRUCTIONS,
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
