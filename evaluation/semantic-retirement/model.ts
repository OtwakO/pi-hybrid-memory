import type { AssistantMessage, Context, ToolCall, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type {
  CompletionState,
  ProposedReflection,
  ProposedRetirement,
  ProtocolProposal,
} from "./protocol.js";
import {
  isProposedReflection,
  isProposedRetirement,
  isProtocolProposal,
} from "./protocol.js";

const ReflectionSchema = Type.Object({
  proposalId: Type.String({ minLength: 1 }),
  content: Type.String({ minLength: 1 }),
  supportingObservationIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
}, { additionalProperties: false });

const RetirementSchema = Type.Object({
  observationId: Type.String({ minLength: 1 }),
  preservedByReflectionIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
  reason: Type.Literal("fully-absorbed"),
}, { additionalProperties: false });

const CombinedSchema = Type.Object({
  reflections: Type.Array(ReflectionSchema),
  retirements: Type.Array(RetirementSchema),
}, { additionalProperties: false });

const ReflectionsSchema = Type.Object({ reflections: Type.Array(ReflectionSchema) }, { additionalProperties: false });
const RetirementsSchema = Type.Object({ retirements: Type.Array(RetirementSchema) }, { additionalProperties: false });

export interface ExperimentCompletion<T> {
  state: CompletionState;
  value?: T;
  usage?: Usage;
  stopReason?: AssistantMessage["stopReason"];
}

const toolCall = (message: AssistantMessage, expectedName: string): ToolCall | undefined => {
  const calls = message.content.filter((item): item is ToolCall => item.type === "toolCall");
  return calls.length === 1 && calls[0].name === expectedName ? calls[0] : undefined;
};

const completionState = (message: AssistantMessage): CompletionState => {
  if (message.stopReason === "length") return "truncated";
  if (message.stopReason === "aborted") return "aborted";
  if (message.stopReason === "error" || message.stopReason === "deferred" || message.stopReason === "pending") return "error";
  return "success";
};

export class SemanticRetirementModel {
  private constructor(
    private readonly runtime: ModelRuntime,
    private readonly model: NonNullable<ReturnType<ModelRuntime["getModel"]>>,
  ) {}

  static async create(): Promise<SemanticRetirementModel> {
    const runtime = await ModelRuntime.create();
    const model = runtime.getModel("opencode-go", "deepseek-v4-flash");
    if (!model) throw new Error("Evaluation model opencode-go/deepseek-v4-flash is not available.");
    const available = await runtime.getAvailable("opencode-go", { signal: AbortSignal.timeout(15_000) });
    if (!available.some(candidate => candidate.id === model.id)) {
      throw new Error("Evaluation model opencode-go/deepseek-v4-flash is not authenticated.");
    }
    return new SemanticRetirementModel(runtime, model);
  }

  private async complete<T>(input: {
    systemPrompt: string;
    userPrompt: string;
    toolName: string;
    schema: ReturnType<typeof Type.Object>;
    validate: (value: unknown) => value is T;
  }): Promise<ExperimentCompletion<T>> {
    let message: AssistantMessage;
    try {
      const context: Context = {
        systemPrompt: input.systemPrompt,
        messages: [{ role: "user", content: input.userPrompt, timestamp: Date.now() }],
        tools: [{
          name: input.toolName,
          description: "Submit the complete constrained evaluation result.",
          parameters: input.schema,
          constrainedSampling: { type: "json_schema", strict: "prefer" },
        }],
      };
      message = await this.runtime.complete(this.model, context, {
        signal: AbortSignal.timeout(5 * 60_000),
        maxTokens: 16_384,
        maxRetries: 0,
      });
    } catch {
      return { state: "error" };
    }
    const state = completionState(message);
    if (state !== "success") return { state, usage: message.usage, stopReason: message.stopReason };
    const call = toolCall(message, input.toolName);
    if (!call) return { state: "invalid-output", usage: message.usage, stopReason: message.stopReason };
    if (!input.validate(call.arguments)) {
      return { state: "invalid-output", usage: message.usage, stopReason: message.stopReason };
    }
    return { state: "success", value: call.arguments, usage: message.usage, stopReason: message.stopReason };
  }

  combined(systemPrompt: string, userPrompt: string): Promise<ExperimentCompletion<ProtocolProposal>> {
    return this.complete({
      systemPrompt,
      userPrompt,
      toolName: "submit_memory_evaluation",
      schema: CombinedSchema,
      validate: isProtocolProposal,
    });
  }

  reflections(systemPrompt: string, userPrompt: string): Promise<ExperimentCompletion<{ reflections: ProposedReflection[] }>> {
    return this.complete({
      systemPrompt,
      userPrompt,
      toolName: "submit_reflections",
      schema: ReflectionsSchema,
      validate: (value): value is { reflections: ProposedReflection[] } => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const record = value as Record<string, unknown>;
        return Object.keys(record).every(key => key === "reflections")
          && Array.isArray(record.reflections)
          && record.reflections.every(isProposedReflection);
      },
    });
  }

  retirements(systemPrompt: string, userPrompt: string): Promise<ExperimentCompletion<{ retirements: ProposedRetirement[] }>> {
    return this.complete({
      systemPrompt,
      userPrompt,
      toolName: "submit_retirements",
      schema: RetirementsSchema,
      validate: (value): value is { retirements: ProposedRetirement[] } => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const record = value as Record<string, unknown>;
        return Object.keys(record).every(key => key === "retirements")
          && Array.isArray(record.retirements)
          && record.retirements.every(isProposedRetirement);
      },
    });
  }
}
