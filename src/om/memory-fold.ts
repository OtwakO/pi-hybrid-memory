import type { MemoryReflection, ObservationRecord } from "../types.js";
import { runReflector, type ReflectorParams, type ReflectorResult } from "./compaction.js";
import { estimateStringTokens } from "./tokens.js";

export type MemoryFoldFailureReason = Extract<ReflectorResult, { ok: false }>["reason"];

export type MemoryFoldResult =
  | {
      ok: true;
      outcome: "below-threshold" | "reflected" | "deliberate-empty";
      reflections: MemoryReflection[];
      observations: ObservationRecord[];
      retiredObservationIds: [];
    }
  | {
      ok: false;
      stage: "reflection";
      reason: MemoryFoldFailureReason;
      reflections: MemoryReflection[];
      observations: ObservationRecord[];
      retiredObservationIds: [];
    };

interface MemoryFoldInput {
  params: ReflectorParams;
  reflections: MemoryReflection[];
  observations: ObservationRecord[];
  reflectionThresholdTokens: number;
  reflect?: typeof runReflector;
}

/**
 * Produce a validated memory fold while keeping retirement disabled.
 *
 * Q0 makes retention the invariant: reflection may enrich memory, but no
 * observation can leave the active durable set until a later, auditable
 * retirement contract is approved.
 */
export const foldMemory = async (input: MemoryFoldInput): Promise<MemoryFoldResult> => {
  const observations = [...input.observations];
  const reflections = [...input.reflections];
  const observationTokens = observations.reduce(
    (sum, observation) => sum + estimateStringTokens(observation.content),
    0,
  );

  if (observationTokens < input.reflectionThresholdTokens) {
    input.params.telemetry?.recordMemoryLifecycle("reflector", "below-threshold", {
      inputItems: observations.length,
      inputTokens: observationTokens,
    });
    return {
      ok: true,
      outcome: "below-threshold",
      reflections,
      observations,
      retiredObservationIds: [],
    };
  }

  const reflectionResult = await (input.reflect ?? runReflector)(
    input.params,
    reflections,
    observations,
  );
  if (!reflectionResult.ok) {
    return {
      ok: false,
      stage: "reflection",
      reason: reflectionResult.reason,
      reflections,
      observations,
      retiredObservationIds: [],
    };
  }

  return {
    ok: true,
    outcome: reflectionResult.outcome === "deliberate-empty" ? "deliberate-empty" : "reflected",
    reflections: reflectionResult.reflections,
    observations,
    retiredObservationIds: [],
  };
};
