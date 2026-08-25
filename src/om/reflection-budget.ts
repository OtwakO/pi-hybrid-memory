import type { MemoryReflection, ObservationRecord } from "../types.js";
import { estimateStringTokens } from "./tokens.js";

const renderedReflection = (reflection: MemoryReflection): string =>
  typeof reflection === "string"
    ? `- ${reflection}`
    : `- [${reflection.id}] ${reflection.content}`;

const CHARS_PER_TOKEN = 4;
const FIXED_OUTPUT_OVERHEAD_TOKENS = 256;
const CONTEXT_SAFETY_TOKENS = 2_048;
const MAX_PROVIDER_OUTPUT_RESERVE_TOKENS = 16_384;
const REFLECTION_SUMMARY_BUDGET_RATIO = 0.5;
export const MAX_REFLECTION_CONTENT_CHARS = 2_048;

export interface ReflectionModelCapacity {
  contextWindow?: number;
  maxTokens?: number;
}

export interface ReflectionRequestPlan {
  maxOutputTokens: number;
  maxReflections: number;
  maxReflectionContentChars: number;
  estimatedInputTokens: number;
  providerOutputReserveTokens: number;
  estimatedWorstCaseContractTokens: number;
  estimatedWorstCaseOutputTokens: number;
}

export type ReflectionRequestPlanResult =
  | { ok: true; plan: ReflectionRequestPlan }
  | { ok: false; reason: "infeasible-request" };

interface ReflectionRequestPlanInput {
  model: ReflectionModelCapacity;
  systemPrompt: string;
  userPrompt: string;
  existingReflections: readonly MemoryReflection[];
  observations: readonly ObservationRecord[];
  targetSummaryTokens: number;
}

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;

/**
 * Bound only the proposed reflection contract. The complete evidence prompt is
 * never reduced here. If full evidence plus a useful bounded result cannot fit,
 * the fold fails before contacting the provider.
 */
export const planReflectionRequest = (
  input: ReflectionRequestPlanInput,
): ReflectionRequestPlanResult => {
  if (input.observations.length === 0) return { ok: false, reason: "infeasible-request" };

  const modelMaxTokens = positiveInteger(input.model.maxTokens) ?? 4_096;
  const contextWindow = positiveInteger(input.model.contextWindow) ?? 128_000;
  const reflectionSummaryBudgetTokens = Math.floor(
    input.targetSummaryTokens * REFLECTION_SUMMARY_BUDGET_RATIO,
  );
  const existingReflectionTokens = input.existingReflections.reduce(
    (sum, reflection) => sum + estimateStringTokens(renderedReflection(reflection)),
    0,
  );
  const availableSummaryTokens = reflectionSummaryBudgetTokens - existingReflectionTokens;
  if (availableSummaryTokens <= FIXED_OUTPUT_OVERHEAD_TOKENS) {
    return { ok: false, reason: "infeasible-request" };
  }

  const estimatedInputTokens = estimateStringTokens(`${input.systemPrompt}\n${input.userPrompt}`);
  const contextOutputHeadroom = contextWindow - estimatedInputTokens - CONTEXT_SAFETY_TOKENS;
  const providerOutputReserveTokens = Math.min(
    MAX_PROVIDER_OUTPUT_RESERVE_TOKENS,
    Math.floor(modelMaxTokens / 2),
  );
  const contractCapacity = Math.min(
    availableSummaryTokens,
    modelMaxTokens - providerOutputReserveTokens,
    contextOutputHeadroom - providerOutputReserveTokens,
  );
  const perReflectionWorstCaseTokens = Math.ceil(MAX_REFLECTION_CONTENT_CHARS / CHARS_PER_TOKEN) + 64;
  const maxReflections = Math.min(
    input.observations.length,
    Math.floor((contractCapacity - FIXED_OUTPUT_OVERHEAD_TOKENS) / perReflectionWorstCaseTokens),
  );
  if (maxReflections < 1) return { ok: false, reason: "infeasible-request" };

  const estimatedWorstCaseContractTokens =
    FIXED_OUTPUT_OVERHEAD_TOKENS + maxReflections * perReflectionWorstCaseTokens;
  const estimatedWorstCaseOutputTokens = estimatedWorstCaseContractTokens + providerOutputReserveTokens;
  const maxOutputTokens = estimatedWorstCaseOutputTokens;

  return {
    ok: true,
    plan: {
      maxOutputTokens,
      maxReflections,
      maxReflectionContentChars: MAX_REFLECTION_CONTENT_CHARS,
      estimatedInputTokens,
      providerOutputReserveTokens,
      estimatedWorstCaseContractTokens,
      estimatedWorstCaseOutputTokens,
    },
  };
};
