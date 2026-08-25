import type { Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ObserverEpochManager } from "./om/observer-epoch.js";

export type CacheOperation = "observer" | "reflector";
export type CacheCallOutcome = "success" | "error" | "aborted" | "truncated";
export type MemoryLifecycleOperation = "reflector";
export type MemoryLifecycleOutcome =
  | "below-threshold"
  | "success"
  | "deliberate-empty"
  | "no-change"
  | "invalid-output"
  | "invalid-provenance"
  | "truncated-output"
  | "missing-tool-call"
  | "infeasible-request"
  | "error"
  | "aborted";

interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type ObserverCallSource = "proactive" | "catch-up";

export interface CachePrefixMetadata {
  source: ObserverCallSource;
  epochRunIndex: number;
  cold: boolean;
  predictedPrefixTokens: number;
  projectedTokens: number;
  maxTokens: number;
  resetReason?: string;
}

export interface CacheTelemetryCall {
  operation: CacheOperation;
  provider: string;
  model: string;
  timestamp: number;
  outcome: CacheCallOutcome;
  usage?: TokenUsage;
  reportedCost?: CostBreakdown;
  estimatedCost?: CostBreakdown;
  prefix?: CachePrefixMetadata;
}

export interface ObserverCapacityMetadata {
  availableDeltaTokens: number;
  minimumDeltaTokens: number;
  occupiedTokens: number;
  maxTokens: number;
}

export interface ObserverEpochAggregate {
  calls: number;
  proactiveCalls: number;
  catchUpCalls: number;
  coldCalls: number;
  warmCalls: number;
  warmProviderHits: number;
  warmProviderMisses: number;
  minimumHeadroomTokens?: number;
  baselinePressureEvents: number;
  minimumFreshDeltaTokens?: number;
  resetReasons: Record<string, number>;
}

export interface MemoryLifecycleAggregate {
  operation: MemoryLifecycleOperation;
  attempts: number;
  outcomes: Partial<Record<MemoryLifecycleOutcome, number>>;
  inputItems: number;
  inputTokens: number;
  proposedItems: number;
  acceptedItems: number;
}

export interface MemoryLifecycleCounts {
  inputItems?: number;
  inputTokens?: number;
  proposedItems?: number;
  acceptedItems?: number;
}

export interface CacheTelemetryAggregate {
  operation: CacheOperation;
  calls: number;
  successfulCalls: number;
  failedCalls: number;
  measuredCalls: number;
  usage: TokenUsage;
  reportedCost?: number;
  estimatedCost?: number;
}

const zeroUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const usageFrom = (usage: Usage | undefined): TokenUsage | undefined => {
  if (!usage) return undefined;
  if (![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every(finiteNumber)) {
    return undefined;
  }
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
  };
};

const costFrom = (cost: Usage["cost"] | undefined): CostBreakdown | undefined => {
  if (!cost) return undefined;
  if (![cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total].every(finiteNumber)) {
    return undefined;
  }
  return { ...cost };
};

const estimateCost = (model: Model<any>, usage: TokenUsage | undefined): CostBreakdown | undefined => {
  if (!usage || !model.cost) return undefined;
  const prices = model.cost;
  if (![prices.input, prices.output, prices.cacheRead, prices.cacheWrite].every(finiteNumber)) return undefined;
  const input = prices.input * usage.input / 1_000_000;
  const output = prices.output * usage.output / 1_000_000;
  const cacheRead = prices.cacheRead * usage.cacheRead / 1_000_000;
  const cacheWrite = prices.cacheWrite * usage.cacheWrite / 1_000_000;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
};

const newObserverEpochAggregate = (): ObserverEpochAggregate => ({
  calls: 0,
  proactiveCalls: 0,
  catchUpCalls: 0,
  coldCalls: 0,
  warmCalls: 0,
  warmProviderHits: 0,
  warmProviderMisses: 0,
  baselinePressureEvents: 0,
  resetReasons: {},
});

const newMemoryLifecycleAggregate = (
  operation: MemoryLifecycleOperation,
): MemoryLifecycleAggregate => ({
  operation,
  attempts: 0,
  outcomes: {},
  inputItems: 0,
  inputTokens: 0,
  proposedItems: 0,
  acceptedItems: 0,
});

const newAggregate = (operation: CacheOperation): CacheTelemetryAggregate => ({
  operation,
  calls: 0,
  successfulCalls: 0,
  failedCalls: 0,
  measuredCalls: 0,
  usage: zeroUsage(),
  reportedCost: 0,
  estimatedCost: 0,
});

export class CacheTelemetry {
  private readonly recent: CacheTelemetryCall[] = [];
  private observerEpochTotals = newObserverEpochAggregate();
  private readonly memoryLifecycleTotals = new Map<MemoryLifecycleOperation, MemoryLifecycleAggregate>([
    ["reflector", newMemoryLifecycleAggregate("reflector")],
  ]);
  private readonly totals = new Map<CacheOperation, CacheTelemetryAggregate>([
    ["observer", newAggregate("observer")],
    ["reflector", newAggregate("reflector")],
  ]);

  constructor(private readonly recentLimit = 10) {}

  record(
    operation: CacheOperation,
    model: Model<any>,
    outcome: CacheCallOutcome,
    usage?: Usage,
    timestamp = Date.now(),
    prefix?: CachePrefixMetadata,
  ): void {
    const normalizedUsage = usageFrom(usage);
    const call: CacheTelemetryCall = {
      operation,
      provider: model.provider,
      model: model.id,
      timestamp,
      outcome,
      usage: normalizedUsage,
      reportedCost: costFrom(usage?.cost),
      estimatedCost: estimateCost(model, normalizedUsage),
      prefix,
    };
    this.recent.push(call);
    if (this.recent.length > this.recentLimit) {
      this.recent.splice(0, this.recent.length - this.recentLimit);
    }

    const total = this.totals.get(operation)!;
    total.calls++;
    if (outcome === "success") total.successfulCalls++;
    else total.failedCalls++;
    if (normalizedUsage) {
      total.measuredCalls++;
      total.usage.input += normalizedUsage.input;
      total.usage.output += normalizedUsage.output;
      total.usage.cacheRead += normalizedUsage.cacheRead;
      total.usage.cacheWrite += normalizedUsage.cacheWrite;
      total.usage.totalTokens += normalizedUsage.totalTokens;
    }
    if (operation === "observer" && prefix) {
      const epoch = this.observerEpochTotals;
      epoch.calls++;
      if (prefix.source === "proactive") epoch.proactiveCalls++;
      else epoch.catchUpCalls++;
      if (prefix.cold) epoch.coldCalls++;
      else {
        epoch.warmCalls++;
        if (normalizedUsage) {
          if (normalizedUsage.cacheRead > 0) epoch.warmProviderHits++;
          else epoch.warmProviderMisses++;
        }
      }
      if (prefix.resetReason) {
        epoch.resetReasons[prefix.resetReason] = (epoch.resetReasons[prefix.resetReason] ?? 0) + 1;
      }
      const headroom = Math.max(0, prefix.maxTokens - prefix.projectedTokens);
      epoch.minimumHeadroomTokens = epoch.minimumHeadroomTokens === undefined
        ? headroom
        : Math.min(epoch.minimumHeadroomTokens, headroom);
    }

    total.reportedCost = call.reportedCost && total.reportedCost !== undefined
      ? total.reportedCost + call.reportedCost.total
      : undefined;
    total.estimatedCost = call.estimatedCost && total.estimatedCost !== undefined
      ? total.estimatedCost + call.estimatedCost.total
      : undefined;
  }

  recordObserverCapacity(
    _source: ObserverCallSource,
    capacity: ObserverCapacityMetadata,
  ): void {
    const epoch = this.observerEpochTotals;
    epoch.minimumFreshDeltaTokens = epoch.minimumFreshDeltaTokens === undefined
      ? capacity.availableDeltaTokens
      : Math.min(epoch.minimumFreshDeltaTokens, capacity.availableDeltaTokens);
    if (capacity.availableDeltaTokens < capacity.minimumDeltaTokens) {
      epoch.baselinePressureEvents++;
    }
  }

  recordMemoryLifecycle(
    operation: MemoryLifecycleOperation,
    outcome: MemoryLifecycleOutcome,
    counts: MemoryLifecycleCounts = {},
  ): void {
    const aggregate = this.memoryLifecycleTotals.get(operation)!;
    aggregate.attempts++;
    aggregate.outcomes[outcome] = (aggregate.outcomes[outcome] ?? 0) + 1;
    aggregate.inputItems += counts.inputItems ?? 0;
    aggregate.inputTokens += counts.inputTokens ?? 0;
    aggregate.proposedItems += counts.proposedItems ?? 0;
    aggregate.acceptedItems += counts.acceptedItems ?? 0;
  }

  reset(): void {
    this.recent.length = 0;
    this.totals.set("observer", newAggregate("observer"));
    this.totals.set("reflector", newAggregate("reflector"));
    this.observerEpochTotals = newObserverEpochAggregate();
    this.memoryLifecycleTotals.set("reflector", newMemoryLifecycleAggregate("reflector"));
  }

  calls(): readonly CacheTelemetryCall[] {
    return this.recent;
  }

  memoryLifecycleAggregate(operation: MemoryLifecycleOperation): MemoryLifecycleAggregate {
    const aggregate = this.memoryLifecycleTotals.get(operation)!;
    return { ...aggregate, outcomes: { ...aggregate.outcomes } };
  }

  observerEpochAggregate(): ObserverEpochAggregate {
    return {
      ...this.observerEpochTotals,
      resetReasons: { ...this.observerEpochTotals.resetReasons },
    };
  }

  aggregates(): CacheTelemetryAggregate[] {
    return [...this.totals.values()].map((aggregate) => ({
      ...aggregate,
      usage: { ...aggregate.usage },
    }));
  }
}

const formatTokens = (value: number): string => value.toLocaleString();
const formatCost = (value: number | undefined): string => value === undefined ? "unknown" : `$${value.toFixed(6)}`;
const formatRatio = (usage: TokenUsage): string => {
  const cacheableInput = usage.input + usage.cacheRead;
  return cacheableInput > 0 ? `${((usage.cacheRead / cacheableInput) * 100).toFixed(1)}%` : "unknown";
};

export const formatCacheInfo = (
  telemetry: CacheTelemetry,
  observerEpoch?: ObserverEpochManager,
): string => {
  const calls = telemetry.calls();
  const lines = [
    "── Hybrid Memory Cache Telemetry ──",
    "Session-local extension LLM calls only; main Pi conversation usage is not included.",
  ];
  if (observerEpoch) {
    const stats = observerEpoch.stats();
    lines.push(
      "",
      "── Observer epoch ──",
      stats.active
        ? `active: ${stats.runCount} committed run(s), ~${formatTokens(stats.estimatedTokens)} retained tokens, coverage ${stats.coverageEndId ?? "unknown"}`
        : "inactive",
      `last reset: ${stats.lastResetReason ?? "none"}`,
    );
  }
  const lifecycleAggregates = (["reflector"] as const)
    .map(operation => telemetry.memoryLifecycleAggregate(operation))
    .filter(aggregate => aggregate.attempts > 0);
  const observerEpochAggregate = telemetry.observerEpochAggregate();
  if (calls.length === 0 && lifecycleAggregates.length === 0 && observerEpochAggregate.baselinePressureEvents === 0) {
    lines.push("", "No observer or reflector activity recorded in this session.");
    return lines.join("\n");
  }

  if (observerEpochAggregate.calls > 0 || observerEpochAggregate.baselinePressureEvents > 0) {
    const resets = Object.entries(observerEpochAggregate.resetReasons)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => `${reason} ${count}`)
      .join(", ") || "none";
    lines.push(
      "",
      "── Observer continuity ──",
      `observer epochs: ${observerEpochAggregate.coldCalls} cold, ${observerEpochAggregate.warmCalls} warm; proactive ${observerEpochAggregate.proactiveCalls}, catch-up ${observerEpochAggregate.catchUpCalls}`,
      `warm provider cache: ${observerEpochAggregate.warmProviderHits} hit, ${observerEpochAggregate.warmProviderMisses} miss (usage-reported calls only)`,
      `resets: ${resets}`,
      `minimum capacity headroom: ${observerEpochAggregate.minimumHeadroomTokens === undefined ? "unknown" : `~${formatTokens(observerEpochAggregate.minimumHeadroomTokens)} tokens`}`,
      `baseline pressure: ${observerEpochAggregate.baselinePressureEvents} event(s); minimum fresh delta: ${observerEpochAggregate.minimumFreshDeltaTokens === undefined ? "unknown" : `~${formatTokens(observerEpochAggregate.minimumFreshDeltaTokens)} tokens`}`,
    );
  }

  if (lifecycleAggregates.length > 0) {
    lines.push("", "── Memory lifecycle ──");
    for (const aggregate of lifecycleAggregates) {
      const outcomes = Object.entries(aggregate.outcomes)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([outcome, count]) => `${outcome} ${count}`)
        .join(", ");
      lines.push(
        `${aggregate.operation} lifecycle: ${outcomes}`,
        `  input items ${formatTokens(aggregate.inputItems)}, input tokens ~${formatTokens(aggregate.inputTokens)}, proposed ${formatTokens(aggregate.proposedItems)}, accepted ${formatTokens(aggregate.acceptedItems)}`,
      );
    }
  }

  if (calls.length === 0) return lines.join("\n");

  lines.push("", "── Session aggregates ──");
  for (const aggregate of telemetry.aggregates()) {
    if (aggregate.calls === 0) continue;
    lines.push(
      `${aggregate.operation}: ${aggregate.calls} call(s), ${aggregate.successfulCalls} succeeded, ${aggregate.failedCalls} failed`,
      `  tokens: input ${formatTokens(aggregate.usage.input)}, cache read ${formatTokens(aggregate.usage.cacheRead)}, cache write ${formatTokens(aggregate.usage.cacheWrite)}, output ${formatTokens(aggregate.usage.output)}`,
      `  cache read ratio: ${formatRatio(aggregate.usage)} (${aggregate.measuredCalls}/${aggregate.calls} calls reported usage)`,
      `  provider-reported cost: ${formatCost(aggregate.reportedCost)}`,
      `  price-based estimate: ${formatCost(aggregate.estimatedCost)}`,
    );
  }

  lines.push("", "── Recent calls ──");
  for (const call of [...calls].reverse()) {
    const time = new Date(call.timestamp).toLocaleTimeString();
    const usage = call.usage;
    lines.push(
      `${time} ${call.operation} ${call.provider}/${call.model} ${call.outcome}${call.prefix ? ` ${call.prefix.source} epoch#${call.prefix.epochRunIndex} ${call.prefix.cold ? "cold" : "warm"}` : ""}`,
      usage
        ? `  input ${formatTokens(usage.input)}, cache read ${formatTokens(usage.cacheRead)}, cache write ${formatTokens(usage.cacheWrite)}, output ${formatTokens(usage.output)}, hit ${formatRatio(usage)}`
        : "  usage: unknown",
      ...(call.prefix ? [`  local prefix ${formatTokens(call.prefix.predictedPrefixTokens)} / projected ${formatTokens(call.prefix.projectedTokens)} of ${formatTokens(call.prefix.maxTokens)} tokens${call.prefix.resetReason ? `, reset ${call.prefix.resetReason}` : ""}`] : []),
      `  reported ${formatCost(call.reportedCost?.total)}, estimated ${formatCost(call.estimatedCost?.total)}`,
    );
  }
  return lines.join("\n");
};

export const registerCacheInfoCommand = (
  pi: ExtensionAPI,
  telemetry: CacheTelemetry,
  observerEpoch?: ObserverEpochManager,
): void => {
  pi.on("session_start", () => {
    telemetry.reset();
  });

  pi.registerCommand("hm-cache-info", {
    description: "Show session-local hybrid-memory cache and cost telemetry",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatCacheInfo(telemetry, observerEpoch), "info");
    },
  });
};
