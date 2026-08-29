import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  StreamOptions,
  ToolCall,
} from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type {
  CacheTelemetry,
  ReflectionInitialDisposition,
  ReflectionTerminalCategory,
} from "../cache-telemetry.js";
import type { CacheOptions } from "../cache-options.js";
import type { ReflectionRequestPlan } from "./reflection-budget.js";

const DEFAULT_REFLECTION_TIMEOUT_MS = 5 * 60_000;

const reflectionProposalSchema = (plan: ReflectionRequestPlan) => Type.Object({
  reflections: Type.Array(Type.Object({
    content: Type.String({ minLength: 1, maxLength: plan.maxReflectionContentChars }),
    supportingEvidenceHandles: Type.Array(Type.String({ minLength: 1 }), {
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
  | "invalid-output"
  | "timeout"
  | "error"
  | "correction-truncated-output"
  | "correction-timeout"
  | "correction-error"
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
  model: Model<Api>,
  context: Context,
  options: StreamOptions,
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
    if (Object.keys(item).some(key => key !== "content" && key !== "supportingEvidenceHandles")) return false;
    if (typeof item.content !== "string") return false;
    if (item.content.length < 1 || item.content.length > plan.maxReflectionContentChars) return false;
    if (!Array.isArray(item.supportingEvidenceHandles) || item.supportingEvidenceHandles.length < 1) return false;
    if (item.supportingEvidenceHandles.some(id => typeof id !== "string" || id.length < 1)) return false;
    if (new Set(item.supportingEvidenceHandles).size !== item.supportingEvidenceHandles.length) return false;
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

const phaseFailure = (
  turn: number,
  failure: "timeout" | "error" | "truncated-output",
): ReflectionModelFailureReason => turn === 0 ? failure : `correction-${failure}`;

const rejectedCompletionCategory = (error: unknown): ReflectionTerminalCategory => {
  const message = error instanceof Error ? error.message : String(error);
  if (/stream ended|without (?:a )?finish[_ -]?reason|missing finish[_ -]?reason|terminal event/i.test(message)) {
    return "stream-finalization";
  }
  return "rejected-completion";
};

const messageFailureCategory = (message: AssistantMessage): ReflectionTerminalCategory => {
  if (message.stopReason === "length") return "truncation";
  if (message.stopReason !== "error") return "success";
  if (/stream ended|without (?:a )?finish[_ -]?reason|missing finish[_ -]?reason|terminal event/i.test(message.errorMessage ?? "")) {
    return "stream-finalization";
  }
  return "provider-finish-error";
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
    const timeoutMs = options.timeoutMs ?? DEFAULT_REFLECTION_TIMEOUT_MS;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = params.signal
      ? AbortSignal.any([params.signal, timeoutSignal])
      : timeoutSignal;
    const schema = reflectionProposalSchema(plan);
    const messages: Context["messages"] = [{ role: "user", content: userPrompt, timestamp: Date.now() }];
    const transactionStartedAt = performance.now();
    let initialDisposition: ReflectionInitialDisposition | undefined;
    let initialElapsedMs: number | undefined;
    const recordDiagnostic = (
      turn: number,
      terminalCategory: ReflectionTerminalCategory,
    ): void => params.telemetry?.recordReflectionCompletionDiagnostic({
      stage: turn === 0 ? "initial" : "correction",
      initialDisposition,
      terminalCategory,
      correctionUsed: turn > 0,
      elapsedMs: Math.max(0, performance.now() - transactionStartedAt),
      initialElapsedMs,
    });

    for (let turn = 0; turn < 2; turn++) {
      let message: AssistantMessage;
      try {
        message = await raceWithAbort(options.complete(model, {
          systemPrompt,
          messages: structuredClone(messages),
          tools: [{
            name: "submit_reflections",
            description:
              "Submit the complete set of new durable reflections for this bounded evidence window. " +
              "Use an empty reflections array when no new reflection is justified.",
            parameters: schema,
            constrainedSampling: { type: "json_schema", strict: "prefer" },
          }],
        }, {
          signal,
          maxRetries: 0,
          maxRetryDelayMs: 0,
          cacheRetention: params.cacheOptions?.cacheRetention,
          sessionId: params.cacheOptions?.sessionId,
        }), signal);
      } catch (error) {
        const reason: ReflectionModelFailureReason = params.signal?.aborted
          ? "aborted"
          : phaseFailure(turn, timeoutSignal.aborted ? "timeout" : "error");
        recordDiagnostic(
          turn,
          params.signal?.aborted
            ? "caller-abort"
            : timeoutSignal.aborted
              ? "deadline"
              : rejectedCompletionCategory(error),
        );
        params.telemetry?.record(
          "reflector",
          model,
          reason === "aborted"
            ? "aborted"
            : reason === "timeout" || reason === "correction-timeout"
              ? "timeout"
              : "error",
        );
        return { ok: false, reason };
      }

      const callOutcome = message.stopReason === "aborted"
        && timeoutSignal.aborted
        && !params.signal?.aborted
        ? "timeout"
        : completionOutcome(message);
      params.telemetry?.record(
        "reflector",
        model,
        callOutcome,
        message.usage,
      );

      if (message.stopReason === "length") {
        recordDiagnostic(turn, "truncation");
        return { ok: false, reason: phaseFailure(turn, "truncated-output") };
      }
      if (message.stopReason === "aborted") {
        const reason: ReflectionModelFailureReason = params.signal?.aborted
          ? "aborted"
          : phaseFailure(turn, timeoutSignal.aborted ? "timeout" : "error");
        recordDiagnostic(
          turn,
          params.signal?.aborted ? "caller-abort" : timeoutSignal.aborted ? "deadline" : "rejected-completion",
        );
        return { ok: false, reason };
      }
      if (message.stopReason === "error") {
        recordDiagnostic(turn, messageFailureCategory(message));
        return { ok: false, reason: phaseFailure(turn, "error") };
      }

      const calls = toolCalls(message);
      if (
        calls.length === 1
        && calls[0].name === "submit_reflections"
        && isReflectionProposal(calls[0].arguments, plan)
      ) {
        recordDiagnostic(turn, "success");
        return { ok: true, proposal: structuredClone(calls[0].arguments) };
      }

      const disposition: ReflectionInitialDisposition = calls.length === 0
        ? "missing-tool-call"
        : "invalid-output";
      if (turn === 1) {
        recordDiagnostic(turn, disposition);
        return { ok: false, reason: disposition };
      }
      initialDisposition = disposition;
      initialElapsedMs = Math.max(0, performance.now() - transactionStartedAt);
      messages[0] = {
        role: "user",
        content:
          `${userPrompt}\n\nCorrection required: call submit_reflections exactly once with valid arguments. ` +
          "Cite only the request-local evidence handles shown in the bounded evidence set.",
        timestamp: Date.now(),
      };
    }

    return { ok: false, reason: "invalid-output" };
  },
});
