import {
  agentLoop,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import type { Message, Model, Usage } from "@mariozechner/pi-ai";
import { Type, type Static } from "typebox";
import type { CacheTelemetry } from "../cache-telemetry.js";
import type { CacheOptions } from "../cache-options.js";
import type { ReflectionRequestPlan } from "./reflection-budget.js";

const reflectionProposalSchema = (plan: ReflectionRequestPlan) => Type.Object({
  reflections: Type.Array(Type.Object({
    content: Type.String({ minLength: 1, maxLength: plan.maxReflectionContentChars }),
    supportingObservationIds: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      uniqueItems: true,
    }),
  }), {
    maxItems: plan.maxReflections,
    description: "New durable reflections. Use an empty array when no new reflection is justified.",
  }),
});

type ReflectionProposal = Static<ReturnType<typeof reflectionProposalSchema>>;

export interface ReflectionModelParams {
  model: unknown;
  apiKey: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  telemetry?: CacheTelemetry;
  cacheOptions?: CacheOptions;
}

export type ReflectionModelFailureReason =
  | "truncated-output"
  | "missing-tool-call"
  | "invalid-output"
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

const assistantMessages = (event: AgentEvent): Array<{
  role?: string;
  stopReason?: string;
  usage?: Usage;
}> => {
  if (event.type === "message_end" || event.type === "turn_end") {
    return event.message && typeof event.message === "object"
      ? [event.message as { role?: string; stopReason?: string; usage?: Usage }]
      : [];
  }
  if (event.type === "agent_end") {
    return event.messages.filter((message): message is Message =>
      !!message && typeof message === "object" && (message as { role?: string }).role === "assistant");
  }
  return [];
};

const terminalFailureFromEvent = (event: AgentEvent): ReflectionModelFailureReason | null => {
  for (const message of assistantMessages(event)) {
    if (message.role !== "assistant") continue;
    if (message.stopReason === "length") return "truncated-output";
    if (message.stopReason === "error") return "error";
    if (message.stopReason === "aborted") return "aborted";
  }
  return null;
};

export const createAgentLoopReflectionModel = (): ReflectionModelPort => ({
  async propose(params, systemPrompt, userPrompt, plan): Promise<ReflectionModelResult> {
    let proposal: ReflectionProposal | null = null;
    let submissionCount = 0;
    let assistantTurns = 0;
    let attemptedToolCall = false;
    let finalTurnFailure: ReflectionModelFailureReason | null = null;
    let terminalFailure: "error" | "aborted" | null = null;

    const schema = reflectionProposalSchema(plan);
    const submitReflections: AgentTool<any> & {
      constrainedSampling: { type: "json_schema"; strict: "prefer" };
    } = {
      name: "submit_reflections",
      label: "Submit reflections",
      description:
        "Submit the complete set of new durable reflections for this fold. " +
        "Call once with an empty reflections array when no new reflection is justified.",
      parameters: schema as any,
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      execute: async (_toolCallId, args: ReflectionProposal) => {
        submissionCount++;
        if (submissionCount > 1) throw new Error("submit_reflections must be called exactly once");
        proposal = structuredClone(args);
        return {
          content: [{ type: "text" as const, text: "Reflection submission accepted." }],
          details: { proposed: args.reflections.length },
          // Active Pi supports terminating structured-output tools; the pinned
          // development SDK predates this additive field.
          terminate: true,
        } as any;
      },
    };

    const context: AgentContext = {
      systemPrompt,
      messages: [],
      tools: [submitReflections],
    };
    const prompts: Message[] = [{ role: "user", content: userPrompt, timestamp: Date.now() }];
    const config: AgentLoopConfig = {
      model: params.model as any,
      apiKey: params.apiKey,
      headers: params.headers,
      sessionId: params.cacheOptions?.sessionId,
      cacheRetention: params.cacheOptions?.cacheRetention,
      reasoning: "medium",
      maxTokens: plan.maxOutputTokens,
      convertToLlm: (messages) => messages as Message[],
      toolExecution: "sequential",
    };
    // Pinned development typings predate this active-host lifecycle control.
    const configWithBoundedTurns = config as AgentLoopConfig & {
      shouldStopAfterTurn: () => boolean;
    };
    configWithBoundedTurns.shouldStopAfterTurn = () => proposal !== null || assistantTurns >= 2;

    try {
      const stream = agentLoop(prompts, context, configWithBoundedTurns, params.signal);
      for await (const event of stream) {
        const eventFailure = terminalFailureFromEvent(event);
        if (eventFailure === "error" || eventFailure === "aborted") terminalFailure = eventFailure;
        if (event.type === "turn_end" && event.message.role === "assistant") {
          assistantTurns++;
          finalTurnFailure = eventFailure;
        }
        if (event.type === "tool_execution_start") attemptedToolCall = true;
        if (event.type === "message_end" && event.message.role === "assistant") {
          const message = event.message as { stopReason?: string; usage?: Usage };
          const outcome = message.stopReason === "error" ? "error"
            : message.stopReason === "aborted" ? "aborted"
              : message.stopReason === "length" ? "truncated"
                : "success";
          params.telemetry?.record(
            "reflector",
            params.model as Model<any>,
            outcome,
            message.usage,
          );
        }
      }
      await stream.result();
    } catch {
      return { ok: false, reason: "error" };
    }

    if (terminalFailure) return { ok: false, reason: terminalFailure };
    if (submissionCount > 1) return { ok: false, reason: "invalid-output" };
    if (proposal) return { ok: true, proposal };
    if (finalTurnFailure) return { ok: false, reason: finalTurnFailure };
    return { ok: false, reason: attemptedToolCall ? "invalid-output" : "missing-tool-call" };
  },
});
