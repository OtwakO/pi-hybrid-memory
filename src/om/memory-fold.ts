import type { CacheTelemetry, MemoryLifecycleOutcome } from "../cache-telemetry.js";
import type { MemoryReflection, ObservationRecord } from "../types.js";
import { REFLECTOR_PROMPT, REFLECTOR_SYSTEM } from "./prompts.js";
import {
  planReflectionRequest,
  type ReflectionModelCapacity,
} from "./reflection-budget.js";
import {
  createAgentLoopReflectionModel,
  type ReflectionModelFailureReason,
  type ReflectionModelParams,
  type ReflectionModelPort,
} from "./reflection-model.js";
import { validateAndMergeReflections } from "./reflection-validation.js";
import { estimateStringTokens } from "./tokens.js";

export type MemoryFoldFailureReason =
  | ReflectionModelFailureReason
  | "invalid-provenance"
  | "infeasible-request";

export type MemoryFoldResult =
  | {
      ok: true;
      outcome: "below-threshold" | "reflected" | "deliberate-empty" | "no-change";
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
  params: ReflectionModelParams & { telemetry?: CacheTelemetry };
  reflections: MemoryReflection[];
  observations: ObservationRecord[];
  reflectionThresholdTokens: number;
  targetSummaryTokens: number;
  modelPort?: ReflectionModelPort;
}

const recordFailure = (
  telemetry: CacheTelemetry | undefined,
  reason: MemoryFoldFailureReason,
  observations: readonly ObservationRecord[],
  proposedItems = 0,
): void => {
  const lifecycleOutcome = reason as MemoryLifecycleOutcome;
  telemetry?.recordMemoryLifecycle("reflector", lifecycleOutcome, {
    inputItems: observations.length,
    inputTokens: observations.reduce(
      (sum, observation) => sum + estimateStringTokens(observation.content),
      0,
    ),
    proposedItems,
    acceptedItems: 0,
  });
};

const failedFold = (
  reason: MemoryFoldFailureReason,
  reflections: MemoryReflection[],
  observations: ObservationRecord[],
): MemoryFoldResult => ({
  ok: false,
  stage: "reflection",
  reason,
  reflections,
  observations,
  retiredObservationIds: [],
});

/**
 * Produce a validated memory fold while keeping retirement disabled.
 *
 * The fold owns provider orchestration, feasibility, semantic validation, and
 * telemetry. Callers receive either a complete validated result or the exact
 * pre-fold memory set.
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

  const systemPrompt = REFLECTOR_SYSTEM;
  const userPrompt = REFLECTOR_PROMPT(reflections, observations);
  const planResult = planReflectionRequest({
    model: input.params.model as ReflectionModelCapacity,
    systemPrompt,
    userPrompt,
    existingReflections: reflections,
    observations,
    targetSummaryTokens: input.targetSummaryTokens,
  });
  if (!planResult.ok) {
    recordFailure(input.params.telemetry, planResult.reason, observations);
    return failedFold(planResult.reason, reflections, observations);
  }

  const modelResult = await (input.modelPort ?? createAgentLoopReflectionModel()).propose(
    input.params,
    systemPrompt,
    userPrompt,
    planResult.plan,
  );
  if (!modelResult.ok) {
    recordFailure(input.params.telemetry, modelResult.reason, observations);
    return failedFold(modelResult.reason, reflections, observations);
  }

  const validated = validateAndMergeReflections(
    reflections,
    observations,
    modelResult.proposal.reflections,
  );
  if (!validated.ok) {
    recordFailure(
      input.params.telemetry,
      validated.reason,
      observations,
      modelResult.proposal.reflections.length,
    );
    return failedFold(validated.reason, reflections, observations);
  }

  const outcome = validated.proposedItems === 0
    ? "deliberate-empty"
    : validated.acceptedItems === 0
      ? "no-change"
      : "success";
  input.params.telemetry?.recordMemoryLifecycle("reflector", outcome, {
    inputItems: observations.length,
    inputTokens: observationTokens,
    proposedItems: validated.proposedItems,
    acceptedItems: validated.acceptedItems,
  });
  return {
    ok: true,
    outcome: validated.proposedItems === 0
      ? "deliberate-empty"
      : validated.acceptedItems === 0
        ? "no-change"
        : "reflected",
    reflections: validated.reflections,
    observations,
    retiredObservationIds: [],
  };
};
