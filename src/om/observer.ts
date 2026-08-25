// OM Observer: LLM-based observation extraction using agentLoop + tool calling
// Matches pi-observational-memory's design — no JSON parsing, structured via tool schema
import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, Usage } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { CachePrefixMetadata, CacheTelemetry } from "../cache-telemetry.js";
import type { CacheOptions } from "../cache-options.js";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { ObservationRecord, Relevance } from "../types.js";
import { OBSERVER_SYSTEM } from "./prompts.js";

const RelevanceSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("critical"),
]);

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
    }),
    { description: "Batch of observations. May be empty." },
  ),
});

type RecordObservationsArgs = Static<typeof RecordObservationsSchema>;

export interface ObserverParams {
  model: unknown;
  apiKey: string;
  headers?: Record<string, string>;
  contextMessages: Message[];
  prompts: Message[];
  allowedSourceEntryIds: string[];
  signal?: AbortSignal;
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

interface TerminalAssistantMessage {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
}

const terminalAssistantMessages = (event: unknown): TerminalAssistantMessage[] => {
  if (!event || typeof event !== "object") return [];
  const value = event as { type?: string; message?: unknown; messages?: unknown[] };
  if (value.type === "message_end" || value.type === "turn_end") {
    return value.message && typeof value.message === "object"
      ? [value.message as TerminalAssistantMessage]
      : [];
  }
  if (value.type === "agent_end" && Array.isArray(value.messages)) {
    return value.messages.filter((message): message is TerminalAssistantMessage =>
      !!message && typeof message === "object" && (message as TerminalAssistantMessage).role === "assistant");
  }
  return [];
};

const terminalFailure = (event: unknown): string | null => {
  for (const message of terminalAssistantMessages(event)) {
    if (message.role !== "assistant") continue;
    if (message.stopReason !== "error" && message.stopReason !== "aborted") continue;
    return message.errorMessage?.trim() || `assistant stream ${message.stopReason}`;
  }
  return null;
};

export const runObserver = async (params: ObserverParams): Promise<ObserverResult> => {
  const { model, apiKey, headers, contextMessages, prompts, signal } = params;

  if (prompts.length === 0) return { ok: true, records: [], transcriptSuffix: [] };

  const accumulated: ObservationRecord[] = [];
  let provenanceFailure: string | null = null;
  const allowedSourceIds = new Set(params.allowedSourceEntryIds);

  const recordObservations: AgentTool<typeof RecordObservationsSchema> = {
    name: "record_observations",
    label: "Record observations",
    description:
      "Record a batch of new observations distilled from the conversation chunk. " +
      "Call this one or more times as you work through the chunk. Stop calling when coverage is complete.",
    parameters: RecordObservationsSchema,
    execute: async (_id, args: RecordObservationsArgs) => {
      const staged: ObservationRecord[] = [];
      for (const obs of args.observations) {
        const requestedIds = obs.sourceEntryIds;
        const sourceEntryIds = requestedIds === undefined
          ? [...params.allowedSourceEntryIds]
          : [...new Set(requestedIds)];
        if (sourceEntryIds.length === 0 || sourceEntryIds.some(id => !allowedSourceIds.has(id))) {
          provenanceFailure = "record_observations sourceEntryIds must be a non-empty subset of the current source chunk";
          throw new Error(provenanceFailure);
        }
        staged.push({
          id: makeId(),
          content: obs.content.trim(),
          timestamp: new Date().toISOString(),
          relevance: obs.relevance as Relevance,
          sourceEntryIds,
        });
      }
      accumulated.push(...staged);
      provenanceFailure = null;
      return {
        content: [{ type: "text" as const, text: `Recorded ${args.observations.length} observation(s). Total: ${accumulated.length}. Continue or stop calling the tool.` }],
        details: { added: args.observations.length, total: accumulated.length },
      };
    },
  };

  const context: AgentContext = {
    systemPrompt: OBSERVER_SYSTEM,
    messages: structuredClone(contextMessages),
    tools: [recordObservations],
  };
  const config: AgentLoopConfig = {
    model: model as any,
    apiKey,
    headers,
    sessionId: params.cacheOptions?.sessionId,
    cacheRetention: params.cacheOptions?.cacheRetention,
    maxTokens: 4096,
    convertToLlm: (msgs) => msgs as Message[],
    toolExecution: "sequential",
  };

  try {
    const stream = agentLoop(prompts, context, config, signal, streamSimple);

    let streamFailure: string | null = null;
    for await (const event of stream) {
      streamFailure ??= terminalFailure(event);
      if (event.type === "message_end" && event.message.role === "assistant") {
        const assistant = event.message as { stopReason?: string; usage?: Usage };
        const outcome = assistant.stopReason === "error" ? "error"
          : assistant.stopReason === "aborted" ? "aborted"
            : "success";
        params.telemetry?.record(
          "observer",
          params.model as Model<any>,
          outcome,
          assistant.usage,
          Date.now(),
          params.prefixTelemetry,
        );
      }
    }
    const transcriptSuffix = await stream.result() as Message[];

    if (provenanceFailure) {
      return { ok: false, reason: provenanceFailure, rawResponse: "" };
    }
    if (streamFailure) {
      return { ok: false, reason: `agentLoop stream failed: ${streamFailure}`, rawResponse: "" };
    }
    return { ok: true, records: accumulated, transcriptSuffix };
  } catch (error) {
    const msg = provenanceFailure ?? (error instanceof Error ? error.message : String(error));
    return { ok: false, reason: `agentLoop failed: ${msg}`, rawResponse: "" };
  }
};

export const observationsToPromptLines = (records: ObservationRecord[]): string[] =>
  records.map((r) => `[${r.id}] ${r.timestamp} [${r.relevance}] ${r.content}`);
