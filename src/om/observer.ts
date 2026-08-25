// Bounded observation extraction through Pi's session-owned native completion seam.
import {
  StringEnum,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type StreamOptions,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { Type, type Static } from "typebox";
import type { CachePrefixMetadata, CacheTelemetry } from "../cache-telemetry.js";
import type { CacheOptions } from "../cache-options.js";
import type { ObservationRecord, Relevance } from "../types.js";
import { estimateEntryTokens } from "./tokens.js";
import { OBSERVER_SYSTEM } from "./prompts.js";

const DEFAULT_OBSERVER_TIMEOUT_MS = 5 * 60_000;
const MAX_OBSERVER_TURNS = 8;
const OBSERVER_MAX_OUTPUT_TOKENS = 4_096;

const RelevanceSchema = StringEnum(["low", "medium", "high", "critical"] as const);

const RecordObservationsSchema = Type.Object({
  observations: Type.Array(
    Type.Object({
      content: Type.String({
        minLength: 1,
        description: "Single-line plain prose. No markdown, no tags.",
      }),
      relevance: RelevanceSchema,
      sourceEntryIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: "Optional exact subset of source entry ids that directly support this observation. Omit only when the full current chunk supports it.",
      })),
    }, { additionalProperties: false }),
    { description: "Batch of observations. May be empty." },
  ),
}, { additionalProperties: false });

type RecordObservationsArgs = Static<typeof RecordObservationsSchema>;

type ObserverComplete = (
  model: Model<Api>,
  context: Context,
  options: StreamOptions,
) => Promise<AssistantMessage>;

export interface ObserverParams {
  complete: ObserverComplete;
  model: Model<Api>;
  contextMessages: Message[];
  prompts: Message[];
  allowedSourceEntryIds: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  telemetry?: CacheTelemetry;
  cacheOptions?: CacheOptions;
  prefixTelemetry?: CachePrefixMetadata;
}

export type ObserverResult =
  | { ok: true; records: ObservationRecord[]; transcriptSuffix: Message[] }
  | { ok: false; reason: string; rawResponse: string };

let idCounter = 0;

const makeId = (): string => {
  idCounter++;
  return `${Date.now().toString(36).slice(-8)}${idCounter.toString(36).padStart(4, "0")}`;
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

const toolResult = (
  call: ToolCall,
  text: string,
  isError: boolean,
  details: Record<string, unknown> = {},
): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: call.id,
  toolName: call.name,
  content: [{ type: "text", text }],
  details,
  isError,
  timestamp: Date.now(),
});

interface ToolExecutionResult {
  message: ToolResultMessage;
  records: ObservationRecord[];
  failure: string | null;
}

const executeObservationTool = (
  call: ToolCall,
  allowedSourceEntryIds: readonly string[],
): ToolExecutionResult => {
  if (call.name !== "record_observations") {
    const failure = `observer called unsupported tool ${call.name}`;
    return { message: toolResult(call, failure, true), records: [], failure };
  }
  if (!Check(RecordObservationsSchema, call.arguments)) {
    const failure = "record_observations arguments did not match the required schema";
    return { message: toolResult(call, failure, true), records: [], failure };
  }

  const args = call.arguments as RecordObservationsArgs;
  const allowed = new Set(allowedSourceEntryIds);
  const staged: ObservationRecord[] = [];
  for (const observation of args.observations) {
    const sourceEntryIds = observation.sourceEntryIds === undefined
      ? [...allowedSourceEntryIds]
      : [...new Set(observation.sourceEntryIds)];
    if (sourceEntryIds.length === 0 || sourceEntryIds.some(id => !allowed.has(id))) {
      const failure = "record_observations sourceEntryIds must be a non-empty subset of the current source chunk";
      return { message: toolResult(call, failure, true), records: [], failure };
    }
    staged.push({
      id: makeId(),
      content: observation.content.trim(),
      timestamp: new Date().toISOString(),
      relevance: observation.relevance as Relevance,
      sourceEntryIds,
    });
  }

  return {
    message: toolResult(
      call,
      `Recorded ${staged.length} observation(s). Continue with another corrected or additional batch, or stop when this chunk is fully covered.`,
      false,
      { added: staged.length },
    ),
    records: staged,
    failure: null,
  };
};

export const runObserver = async (params: ObserverParams): Promise<ObserverResult> => {
  if (params.prompts.length === 0) return { ok: true, records: [], transcriptSuffix: [] };

  const timeoutMs = params.timeoutMs ?? DEFAULT_OBSERVER_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = params.signal
    ? AbortSignal.any([params.signal, timeoutSignal])
    : timeoutSignal;
  const transcriptSuffix: Message[] = structuredClone(params.prompts);
  const records: ObservationRecord[] = [];
  let finalToolFailure: string | null = null;

  for (let turn = 0; turn < MAX_OBSERVER_TURNS; turn++) {
    const appendedPrefixTokens = transcriptSuffix
      .slice(params.prompts.length)
      .reduce((sum, message) => sum + estimateEntryTokens({ type: "message", message }), 0);
    const turnPrefixTelemetry = params.prefixTelemetry
      ? {
          ...params.prefixTelemetry,
          predictedPrefixTokens: params.prefixTelemetry.predictedPrefixTokens + appendedPrefixTokens,
        }
      : undefined;
    let assistant: AssistantMessage;
    try {
      assistant = await raceWithAbort(params.complete(params.model, {
        systemPrompt: OBSERVER_SYSTEM,
        messages: [...structuredClone(params.contextMessages), ...structuredClone(transcriptSuffix)],
        tools: [{
          name: "record_observations",
          description:
            "Record a batch of new observations distilled from the current source chunk. " +
            "Call again only to add another batch or correct a rejected submission, then stop when coverage is complete.",
          parameters: RecordObservationsSchema,
          constrainedSampling: { type: "json_schema", strict: "prefer" },
        }],
      }, {
        signal,
        maxTokens: OBSERVER_MAX_OUTPUT_TOKENS,
        maxRetries: 0,
        maxRetryDelayMs: 0,
        timeoutMs,
        cacheRetention: params.cacheOptions?.cacheRetention,
        sessionId: params.cacheOptions?.sessionId,
      }), signal);
    } catch {
      const reason = params.signal?.aborted
        ? "observer aborted"
        : timeoutSignal.aborted
          ? "observer timed out"
          : "observer completion failed";
      params.telemetry?.record(
        "observer",
        params.model,
        reason === "observer aborted" ? "aborted" : "error",
        undefined,
        Date.now(),
        turnPrefixTelemetry,
      );
      return { ok: false, reason, rawResponse: "" };
    }

    transcriptSuffix.push(assistant);
    params.telemetry?.record(
      "observer",
      params.model,
      completionOutcome(assistant),
      assistant.usage,
      Date.now(),
      params.prefixTelemetry,
    );

    if (assistant.stopReason === "length") {
      return { ok: false, reason: "observer output truncated", rawResponse: "" };
    }
    if (assistant.stopReason === "error") {
      return {
        ok: false,
        reason: assistant.errorMessage?.trim() || "observer provider failed",
        rawResponse: "",
      };
    }
    if (assistant.stopReason === "aborted") {
      return { ok: false, reason: "observer aborted", rawResponse: "" };
    }
    if (assistant.stopReason === "deferred" || assistant.stopReason === "pending") {
      return { ok: false, reason: `observer returned unsupported ${assistant.stopReason} response`, rawResponse: "" };
    }

    const calls = toolCalls(assistant);
    if (calls.length === 0) {
      if (assistant.stopReason === "toolUse") {
        return { ok: false, reason: "observer returned toolUse without a tool call", rawResponse: "" };
      }
      if (finalToolFailure) return { ok: false, reason: finalToolFailure, rawResponse: "" };
      return { ok: true, records, transcriptSuffix };
    }

    for (const call of calls) {
      const execution = executeObservationTool(call, params.allowedSourceEntryIds);
      transcriptSuffix.push(execution.message);
      if (execution.failure) {
        finalToolFailure = execution.failure;
      } else {
        records.push(...execution.records);
        finalToolFailure = null;
      }
    }
  }

  return { ok: false, reason: `observer turn limit exceeded (${MAX_OBSERVER_TURNS})`, rawResponse: "" };
};

export const observationsToPromptLines = (records: ObservationRecord[]): string[] =>
  records.map(record => `[${record.id}] ${record.timestamp} [${record.relevance}] ${record.content}`);
