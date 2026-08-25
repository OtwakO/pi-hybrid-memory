import type { Message } from "@mariozechner/pi-ai";
import { estimateStringTokens } from "./tokens.js";

export type ObserverEpochResetReason =
  | "initial"
  | "manual"
  | "session-change"
  | "compaction"
  | "catch-up-persisted"
  | "coverage-discontinuity"
  | "compatibility-change"
  | "capacity";

export interface ObserverEpochPrepareInput {
  compatibilityKey: string;
  expectedCoverageId: string;
  baselineText: string;
  deltaText: string;
  maxTokens: number;
  fixedTokens: number;
}

export interface PreparedObserverEpoch {
  ok: true;
  transactionId: number;
  compatibilityKey: string;
  contextMessages: Message[];
  prompts: Message[];
  cold: boolean;
  resetReason?: ObserverEpochResetReason;
  predictedPrefixTokens: number;
  projectedTokens: number;
  runIndex: number;
}

export type ObserverEpochPreparation =
  | PreparedObserverEpoch
  | { ok: false; reason: "fresh-baseline-overflow"; projectedTokens: number; maxTokens: number };

export interface FreshEpochBudgetInput {
  baselineText: string;
  maxTokens: number;
  fixedTokens: number;
  deltaOverheadText: string;
}

export interface FreshEpochCapacityInput extends FreshEpochBudgetInput {
  minimumDeltaTokens: number;
}

export interface FreshEpochCapacity {
  occupiedTokens: number;
  availableDeltaTokens: number;
  maxTokens: number;
  minimumDeltaTokens: number;
  pressured: boolean;
}

export interface ObserverEpochStats {
  active: boolean;
  runCount: number;
  coverageEndId?: string;
  estimatedTokens: number;
  compatibilityKey?: string;
  lastResetReason?: ObserverEpochResetReason;
}

interface EpochState {
  compatibilityKey: string;
  messages: Message[];
  coverageEndId: string;
  estimatedTokens: number;
  runCount: number;
  lastResetReason: ObserverEpochResetReason;
}

const BASELINE_PREFIX = "OBSERVER MEMORY BASELINE\n";
const DELTA_PREFIX = "NEW CONVERSATION CHUNK\n";

const userMessage = (content: string): Message => ({ role: "user", content, timestamp: 0 });

const cloneMessages = (messages: readonly Message[]): Message[] =>
  messages.map((message) => structuredClone(message));

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") return value.text;
    if (value.type === "thinking" && typeof value.thinking === "string") return value.thinking;
    if (value.type === "toolCall") return `${String(value.name ?? "tool")} ${JSON.stringify(value.arguments ?? {})}`;
    return "";
  }).filter(Boolean).join("\n");
};

const messageTokens = (messages: readonly Message[]): number =>
  messages.reduce((total, message) => total + estimateStringTokens(`${message.role}\n${contentText(message.content)}`), 0);

const startsWithPrompts = (messages: readonly Message[], prompts: readonly Message[]): boolean => {
  if (messages.length < prompts.length) return false;
  return prompts.every((prompt, index) => JSON.stringify(messages[index]) === JSON.stringify(prompt));
};

export class ObserverEpochManager {
  private state: EpochState | null = null;
  private transactionCounter = 0;

  freshEpochCapacity(input: FreshEpochCapacityInput): FreshEpochCapacity {
    const baselineMessage = userMessage(`${BASELINE_PREFIX}${input.baselineText.trim()}`);
    const overheadMessage = userMessage(`${DELTA_PREFIX}${input.deltaOverheadText.trim()}`);
    const occupiedTokens = input.fixedTokens + messageTokens([baselineMessage, overheadMessage]);
    const availableDeltaTokens = Math.max(0, input.maxTokens - occupiedTokens);
    return {
      occupiedTokens,
      availableDeltaTokens,
      maxTokens: input.maxTokens,
      minimumDeltaTokens: input.minimumDeltaTokens,
      pressured: availableDeltaTokens < input.minimumDeltaTokens,
    };
  }

  freshDeltaTokenBudget(input: FreshEpochBudgetInput): number {
    return this.freshEpochCapacity({ ...input, minimumDeltaTokens: 0 }).availableDeltaTokens;
  }

  prepare(input: ObserverEpochPrepareInput): ObserverEpochPreparation {
    const baselineMessage = userMessage(`${BASELINE_PREFIX}${input.baselineText.trim()}`);
    const deltaMessage = userMessage(`${DELTA_PREFIX}${input.deltaText.trim()}`);
    const freshMessages = [baselineMessage];
    const freshProjectedTokens = input.fixedTokens + messageTokens([...freshMessages, deltaMessage]);
    if (freshProjectedTokens > input.maxTokens) {
      return {
        ok: false,
        reason: "fresh-baseline-overflow",
        projectedTokens: freshProjectedTokens,
        maxTokens: input.maxTokens,
      };
    }

    let baseMessages: Message[];
    let cold = false;
    let resetReason: ObserverEpochResetReason | undefined;

    if (!this.state) {
      baseMessages = freshMessages;
      cold = true;
      resetReason = this.lastInvalidationReason ?? "initial";
    } else if (this.state.compatibilityKey !== input.compatibilityKey) {
      baseMessages = freshMessages;
      cold = true;
      resetReason = "compatibility-change";
    } else if (this.state.coverageEndId !== input.expectedCoverageId) {
      baseMessages = freshMessages;
      cold = true;
      resetReason = "coverage-discontinuity";
    } else {
      const warmProjectedTokens = input.fixedTokens + messageTokens([...this.state.messages, deltaMessage]);
      if (warmProjectedTokens > input.maxTokens) {
        baseMessages = freshMessages;
        cold = true;
        resetReason = "capacity";
      } else {
        baseMessages = cloneMessages(this.state.messages);
      }
    }

    const projectedTokens = input.fixedTokens + messageTokens([...baseMessages, deltaMessage]);
    return {
      ok: true,
      transactionId: ++this.transactionCounter,
      compatibilityKey: input.compatibilityKey,
      contextMessages: cloneMessages(baseMessages),
      prompts: [deltaMessage],
      cold,
      resetReason,
      predictedPrefixTokens: cold ? input.fixedTokens + messageTokens(baseMessages) : input.fixedTokens + (this.state?.estimatedTokens ?? 0),
      projectedTokens,
      runIndex: cold ? 1 : (this.state?.runCount ?? 0) + 1,
    };
  }

  validateCommit(
    prepared: PreparedObserverEpoch,
    transcriptSuffix: readonly Message[],
  ): void {
    if (prepared.transactionId !== this.transactionCounter) {
      throw new Error("observer epoch transaction is stale or was not prepared by this manager");
    }
    if (!startsWithPrompts(transcriptSuffix, prepared.prompts)) {
      throw new Error("observer transcript suffix does not start with the prepared prompts");
    }
  }

  commit(
    prepared: PreparedObserverEpoch,
    transcriptSuffix: readonly Message[],
    coverageEndId: string,
  ): void {
    this.validateCommit(prepared, transcriptSuffix);
    this.commitValidated(prepared, transcriptSuffix, coverageEndId);
  }

  commitValidated(
    prepared: PreparedObserverEpoch,
    transcriptSuffix: readonly Message[],
    coverageEndId: string,
  ): void {
    const messages = [...cloneMessages(prepared.contextMessages), ...cloneMessages(transcriptSuffix)];
    this.state = {
      compatibilityKey: prepared.compatibilityKey,
      messages,
      coverageEndId,
      estimatedTokens: messageTokens(messages),
      runCount: prepared.runIndex,
      lastResetReason: prepared.resetReason ?? this.state?.lastResetReason ?? "initial",
    };
    this.lastInvalidationReason = undefined;
  }

  invalidate(reason: ObserverEpochResetReason = "manual"): void {
    this.state = null;
    this.transactionCounter++;
    this.lastInvalidationReason = reason;
  }

  private lastInvalidationReason: ObserverEpochResetReason | undefined;

  fork(): ObserverEpochManager {
    const fork = new ObserverEpochManager();
    fork.transactionCounter = this.transactionCounter;
    fork.lastInvalidationReason = this.lastInvalidationReason;
    fork.state = this.state
      ? { ...this.state, messages: cloneMessages(this.state.messages) }
      : null;
    return fork;
  }

  stats(): ObserverEpochStats {
    if (!this.state) {
      return {
        active: false,
        runCount: 0,
        estimatedTokens: 0,
        lastResetReason: this.lastInvalidationReason,
      };
    }
    return {
      active: true,
      runCount: this.state.runCount,
      coverageEndId: this.state.coverageEndId,
      estimatedTokens: this.state.estimatedTokens,
      compatibilityKey: this.state.compatibilityKey,
      lastResetReason: this.state.lastResetReason,
    };
  }
}
