// OM Observer: LLM-based observation extraction using agentLoop + tool calling
// Matches pi-observational-memory's design — no JSON parsing, structured via tool schema
import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Message, Model, Usage } from "@mariozechner/pi-ai";
import type { CacheTelemetry } from "../cache-telemetry.js";
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
    }),
    { description: "Batch of observations. May be empty." },
  ),
});

type RecordObservationsArgs = Static<typeof RecordObservationsSchema>;

export interface ObserverParams {
  model: unknown;
  apiKey: string;
  headers?: Record<string, string>;
  priorReflections: string[];
  priorObservations: string[];
  chunk: string;
  allowedSourceEntryIds: string[];
  signal?: AbortSignal;
  telemetry?: CacheTelemetry;
}

export type ObserverResult =
  | { ok: true; records: ObservationRecord[] }
  | { ok: false; reason: string; rawResponse: string };

let idCounter = 0;

const makeId = (): string => {
  idCounter++;
  return `${Date.now().toString(36).slice(-8)}${idCounter.toString(36).padStart(4, "0")}`;
};

const joinOrEmpty = (items: string[]): string => items.length ? items.join("\n") : "(none yet)";

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
  const { model, apiKey, headers, priorReflections, priorObservations, chunk, signal } = params;

  const conversation = chunk.trim();
  if (!conversation) return { ok: true, records: [] };

  const accumulated: ObservationRecord[] = [];

  const recordObservations: AgentTool<any> = {
    name: "record_observations",
    label: "Record observations",
    description:
      "Record a batch of new observations distilled from the conversation chunk. " +
      "Call this one or more times as you work through the chunk. Stop calling when coverage is complete.",
    parameters: RecordObservationsSchema as any,
    execute: async (_id, args: RecordObservationsArgs) => {
      for (const obs of args.observations) {
        accumulated.push({
          id: makeId(),
          content: obs.content.trim(),
          timestamp: new Date().toISOString(),
          relevance: obs.relevance as Relevance,
          sourceEntryIds: [...params.allowedSourceEntryIds],
        });
      }
      return {
        content: [{ type: "text" as const, text: `Recorded ${args.observations.length} observation(s). Total: ${accumulated.length}. Continue or stop calling the tool.` }],
        details: { added: args.observations.length, total: accumulated.length },
      };
    },
  };

  const system = OBSERVER_SYSTEM;
  const userText =
    `Compress the new conversation chunk into observations by calling record_observations one or more times. ` +
    `Do not restate facts already present in current reflections or current observations. ` +
    `Stop calling the tool and reply with a short plain-text confirmation once the chunk is fully covered.\n\n` +
    `CURRENT REFLECTIONS:\n${joinOrEmpty(priorReflections)}\n\n` +
    `CURRENT OBSERVATIONS:\n${joinOrEmpty(priorObservations)}\n\n` +
    `NEW CONVERSATION CHUNK:\n${conversation}`;

  const prompts: Message[] = [{ role: "user", content: userText, timestamp: Date.now() } as Message];
  const context: AgentContext = {
    systemPrompt: system,
    messages: [],
    tools: [recordObservations],
  };
  const config: AgentLoopConfig = {
    model: model as any,
    apiKey,
    headers,
    maxTokens: 4096,
    convertToLlm: (msgs) => msgs as Message[],
    toolExecution: "sequential",
  };

  try {
    const stream = agentLoop(prompts, context, config, signal);

    let streamFailure: string | null = null;
    for await (const event of stream) {
      streamFailure ??= terminalFailure(event);
      if (event.type === "message_end" && event.message.role === "assistant") {
        const assistant = event.message as { stopReason?: string; usage?: Usage };
        const outcome = assistant.stopReason === "error" ? "error"
          : assistant.stopReason === "aborted" ? "aborted"
            : "success";
        params.telemetry?.record("observer", params.model as Model<any>, outcome, assistant.usage);
      }
    }
    await stream.result();

    if (streamFailure) {
      return { ok: false, reason: `agentLoop stream failed: ${streamFailure}`, rawResponse: "" };
    }
    return { ok: true, records: accumulated };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `agentLoop failed: ${msg}`, rawResponse: "" };
  }
};

export const observationsToPromptLines = (records: ObservationRecord[]): string[] =>
  records.map((r) => `[${r.id}] ${r.timestamp} [${r.relevance}] ${r.content}`);
