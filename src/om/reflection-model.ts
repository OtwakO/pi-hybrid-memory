import {
  hasApi,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type OpenAICompletionsOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { CacheTelemetry } from "../cache-telemetry.js";
import type { CacheOptions } from "../cache-options.js";
import type { ReflectionRequestPlan } from "./reflection-budget.js";

const DEFAULT_REFLECTION_TIMEOUT_MS = 5 * 60_000;

const reflectionProposalSchema = (plan: ReflectionRequestPlan) => Type.Object({
  reflections: Type.Array(Type.Object({
    content: Type.String({ minLength: 1, maxLength: plan.maxReflectionContentChars }),
    supportingObservationIds: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      uniqueItems: true,
    }),
  }, { additionalProperties: false }), {
    maxItems: plan.maxReflections,
    description: "New durable reflections. Use an empty array when no new reflection is justified.",
  }),
}, { additionalProperties: false });

type ReflectionProposal = Static<ReturnType<typeof reflectionProposalSchema>>;

export interface ReflectionModelParams {
  model: Model<Api>;
  signal?: AbortSignal;
  telemetry?: CacheTelemetry;
  cacheOptions?: CacheOptions;
}

export type ReflectionModelFailureReason =
  | "truncated-output"
  | "missing-tool-call"
  | "unsupported-api"
  | "invalid-output"
  | "timeout"
  | "error"
  | "aborted";

export type ReflectionModelResult =
  | { ok: true; proposal: ReflectionProposal }
  | { ok: false; reason: ReflectionModelFailureReason };

export interface ReflectionModelPort {
  propose(
    params: ReflectionModelParams,
    systemPrompt: string,
    userPrompt: string,
    plan: ReflectionRequestPlan,
  ): Promise<ReflectionModelResult>;
}

export type ReflectionComplete = (
  model: Model<"openai-completions">,
  context: Context,
  options: OpenAICompletionsOptions,
) => Promise<AssistantMessage>;

interface CompletionReflectionModelOptions {
  complete: ReflectionComplete;
  timeoutMs?: number;
}

const isReflectionProposal = (
  value: unknown,
  plan: ReflectionRequestPlan,
): value is ReflectionProposal => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => key !== "reflections")) return false;
  if (!Array.isArray(object.reflections) || object.reflections.length > plan.maxReflections) return false;

  for (const reflection of object.reflections) {
    if (!reflection || typeof reflection !== "object" || Array.isArray(reflection)) return false;
    const item = reflection as Record<string, unknown>;
    if (Object.keys(item).some(key => key !== "content" && key !== "supportingObservationIds")) return false;
    if (typeof item.content !== "string") return false;
    if (item.content.length < 1 || item.content.length > plan.maxReflectionContentChars) return false;
    if (!Array.isArray(item.supportingObservationIds) || item.supportingObservationIds.length < 1) return false;
    if (item.supportingObservationIds.some(id => typeof id !== "string" || id.length < 1)) return false;
    if (new Set(item.supportingObservationIds).size !== item.supportingObservationIds.length) return false;
  }
  return true;
};

const toolCalls = (message: AssistantMessage): ToolCall[] =>
  message.content.filter((content): content is ToolCall => content.type === "toolCall");

const completionOutcome = (message: AssistantMessage): "success" | "error" | "aborted" | "truncated" => {
  if (message.stopReason === "error") return "error";
  if (message.stopReason === "aborted") return "aborted";
  if (message.stopReason === "length") return "truncated";
  return "success";
};

const raceWithAbort = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

export const createCompletionReflectionModel = (
  options: CompletionReflectionModelOptions,
): ReflectionModelPort => ({
  async propose(params, systemPrompt, userPrompt, plan): Promise<ReflectionModelResult> {
    const model = params.model;
    if (!hasApi(model, "openai-completions")) {
      return { ok: false, reason: "unsupported-api" };
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_REFLECTION_TIMEOUT_MS;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = params.signal
      ? AbortSignal.any([params.signal, timeoutSignal])
      : timeoutSignal;
    const schema = reflectionProposalSchema(plan);
    const context: Context = {
      systemPrompt,
      messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
      tools: [{
        name: "submit_reflections",
        description:
          "Submit the complete set of new durable reflections for this fold. " +
          "Use an empty reflections array when no new reflection is justified.",
        parameters: schema,
        constrainedSampling: { type: "json_schema", strict: "prefer" },
      }],
    };

    let message: AssistantMessage;
    try {
      message = await raceWithAbort(options.complete(model, context, {
        signal,
        reasoningEffort: "high",
        maxTokens: plan.maxOutputTokens,
        maxRetries: 0,
        maxRetryDelayMs: 0,
        timeoutMs,
        cacheRetention: params.cacheOptions?.cacheRetention,
        sessionId: params.cacheOptions?.sessionId,
        toolChoice: {
          type: "function",
          function: { name: "submit_reflections" },
        },
      }), signal);
    } catch {
      const reason: ReflectionModelFailureReason = params.signal?.aborted
        ? "aborted"
        : timeoutSignal.aborted
          ? "timeout"
          : "error";
      params.telemetry?.record(
        "reflector",
        model,
        reason === "aborted" ? "aborted" : "error",
      );
      return { ok: false, reason };
    }

    params.telemetry?.record(
      "reflector",
      model,
      completionOutcome(message),
      message.usage,
    );

    if (message.stopReason === "length") return { ok: false, reason: "truncated-output" };
    if (message.stopReason === "aborted") {
      return { ok: false, reason: params.signal?.aborted ? "aborted" : "error" };
    }
    if (message.stopReason === "error") return { ok: false, reason: "error" };

    const calls = toolCalls(message);
    if (calls.length === 0) return { ok: false, reason: "missing-tool-call" };
    if (calls.length !== 1 || calls[0].name !== "submit_reflections") {
      return { ok: false, reason: "invalid-output" };
    }
    if (!isReflectionProposal(calls[0].arguments, plan)) {
      return { ok: false, reason: "invalid-output" };
    }
    return { ok: true, proposal: structuredClone(calls[0].arguments) };
  },
});
