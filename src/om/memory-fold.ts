import type { CacheTelemetry, MemoryLifecycleOutcome } from "../cache-telemetry.js";
import type { MemoryReflection, ObservationRecord, ObservationRetirement, ReflectionSupersession } from "../types.js";
import { REFLECTOR_PROMPT, REFLECTOR_SYSTEM } from "./prompts.js";
import { planReflectionContext, type ReflectionContextBudgets } from "./reflection-context-plan.js";
import { resolveReflectionHandles } from "./reflection-handle-resolution.js";
import {
  planReflectionRequest,
  type ReflectionModelCapacity,
} from "./reflection-budget.js";
import {
  type ReflectionModelFailureReason,
  type ReflectionModelParams,
  type ReflectionModelPort,
} from "./reflection-model.js";
import { validateAndMergeReflections } from "./reflection-validation.js";
import { estimateStringTokens } from "./tokens.js";
import { planExactDuplicateRetirements } from "./observation-retirement.js";

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
      retirements: ObservationRetirement[];
      supersessions: ReflectionSupersession[];
    }
  | {
      ok: false;
      stage: "reflection";
      reason: MemoryFoldFailureReason;
      reflections: MemoryReflection[];
      observations: ObservationRecord[];
      retirements: ObservationRetirement[];
      supersessions: ReflectionSupersession[];
    };

interface MemoryFoldInput {
  params: ReflectionModelParams & { telemetry?: CacheTelemetry };
  reflections: MemoryReflection[];
  observations: ObservationRecord[];
  focusObservations: ObservationRecord[];
  canonicalObservationIds: ReadonlySet<string>;
  contextBudgets: ReflectionContextBudgets;
  reflectionThresholdTokens: number;
  targetSummaryTokens: number;
  modelPort: ReflectionModelPort;
}

const recordFailure = (
  telemetry: CacheTelemetry | undefined,
  reason: MemoryFoldFailureReason,
  observations: readonly ObservationRecord[],
  proposedItems = 0,
  rejectedItems = 0,
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
    rejectedItems,
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
  retirements: [],
  supersessions: [],
});

/**
 * Produce a validated memory fold with deterministic duplicate retirement and reflection strengthening.
 *
 * The fold owns feasibility, semantic validation, retention policy, and telemetry.
 * Provider execution arrives through the required model port. Callers receive either a complete validated result or the exact
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
    const retirement = planExactDuplicateRetirements(observations, input.canonicalObservationIds);
    return {
      ok: true,
      outcome: "below-threshold",
      reflections,
      observations: retirement.activeObservations,
      retirements: retirement.retirements,
      supersessions: [],
    };
  }

  const focusIds = new Set(input.focusObservations.map(observation => observation.id));
  const focusObservations = observations.filter(observation => focusIds.has(observation.id));
  if (focusObservations.length === 0) {
    const retirement = planExactDuplicateRetirements(observations, input.canonicalObservationIds);
    return {
      ok: true,
      outcome: "no-change",
      reflections,
      observations: retirement.activeObservations,
      retirements: retirement.retirements,
      supersessions: [],
    };
  }
  const historicalObservations = observations.filter(observation => !focusIds.has(observation.id));
  const contextPlan = planReflectionContext({
    reflections,
    focusObservations,
    historicalObservations,
    budgets: input.contextBudgets,
  });
  if (contextPlan.focusOverflow) {
    recordFailure(input.params.telemetry, "infeasible-request", focusObservations);
    return failedFold("infeasible-request", reflections, observations);
  }
  const systemPrompt = REFLECTOR_SYSTEM;
  const userPrompt = REFLECTOR_PROMPT(contextPlan.text);
  const planResult = planReflectionRequest({
    model: input.params.model as ReflectionModelCapacity,
    systemPrompt,
    userPrompt,
    existingReflections: contextPlan.selectedReflections,
    observations: contextPlan.evidence.map(item => item.observation),
    targetSummaryTokens: input.targetSummaryTokens,
  });
  const evidenceObservations = contextPlan.evidence.map(item => item.observation);
  if (!planResult.ok) {
    recordFailure(input.params.telemetry, planResult.reason, evidenceObservations);
    return failedFold(planResult.reason, reflections, observations);
  }

  const modelResult = await input.modelPort.propose(
    input.params,
    systemPrompt,
    userPrompt,
    planResult.plan,
  );
  if (!modelResult.ok) {
    recordFailure(input.params.telemetry, modelResult.reason, evidenceObservations);
    return failedFold(modelResult.reason, reflections, observations);
  }

  const resolved = resolveReflectionHandles(
    modelResult.proposal.reflections,
    contextPlan.handleToObservationId,
  );
  if (resolved.proposedItems > 0 && resolved.candidates.length === 0) {
    recordFailure(
      input.params.telemetry,
      "invalid-provenance",
      evidenceObservations,
      resolved.proposedItems,
      resolved.rejectedItems,
    );
    return failedFold("invalid-provenance", reflections, observations);
  }
  const validated = validateAndMergeReflections(
    reflections,
    observations,
    resolved.candidates,
  );
  if (!validated.ok) {
    recordFailure(
      input.params.telemetry,
      validated.reason,
      evidenceObservations,
      modelResult.proposal.reflections.length,
    );
    return failedFold(validated.reason, reflections, observations);
  }

  const outcome = resolved.proposedItems === 0
    ? "deliberate-empty"
    : validated.acceptedItems === 0
      ? "no-change"
      : "success";
  input.params.telemetry?.recordMemoryLifecycle("reflector", outcome, {
    inputItems: evidenceObservations.length,
    inputTokens: evidenceObservations.reduce(
      (sum, observation) => sum + estimateStringTokens(observation.content),
      0,
    ),
    proposedItems: resolved.proposedItems,
    acceptedItems: validated.acceptedItems,
    rejectedItems: resolved.rejectedItems,
  });
  const retirement = planExactDuplicateRetirements(observations, input.canonicalObservationIds);
  return {
    ok: true,
    outcome: resolved.proposedItems === 0
      ? "deliberate-empty"
      : validated.acceptedItems === 0
        ? "no-change"
        : "reflected",
    reflections: validated.reflections,
    observations: retirement.activeObservations,
    retirements: retirement.retirements,
    supersessions: validated.supersessions,
  };
};
