import type { Model, Usage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type CacheOperation = "observer" | "reflector" | "pruner";
export type CacheCallOutcome = "success" | "error" | "aborted";

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

export interface CacheTelemetryCall {
  operation: CacheOperation;
  provider: string;
  model: string;
  timestamp: number;
  outcome: CacheCallOutcome;
  usage?: TokenUsage;
  reportedCost?: CostBreakdown;
  estimatedCost?: CostBreakdown;
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
  private readonly totals = new Map<CacheOperation, CacheTelemetryAggregate>([
    ["observer", newAggregate("observer")],
    ["reflector", newAggregate("reflector")],
    ["pruner", newAggregate("pruner")],
  ]);

  constructor(private readonly recentLimit = 10) {}

  record(
    operation: CacheOperation,
    model: Model<any>,
    outcome: CacheCallOutcome,
    usage?: Usage,
    timestamp = Date.now(),
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
    total.reportedCost = call.reportedCost && total.reportedCost !== undefined
      ? total.reportedCost + call.reportedCost.total
      : undefined;
    total.estimatedCost = call.estimatedCost && total.estimatedCost !== undefined
      ? total.estimatedCost + call.estimatedCost.total
      : undefined;
  }

  reset(): void {
    this.recent.length = 0;
    this.totals.set("observer", newAggregate("observer"));
    this.totals.set("reflector", newAggregate("reflector"));
    this.totals.set("pruner", newAggregate("pruner"));
  }

  calls(): readonly CacheTelemetryCall[] {
    return this.recent;
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

export const formatCacheInfo = (telemetry: CacheTelemetry): string => {
  const calls = telemetry.calls();
  const lines = [
    "── Hybrid Memory Cache Telemetry ──",
    "Session-local extension LLM calls only; main Pi conversation usage is not included.",
  ];
  if (calls.length === 0) {
    lines.push("", "No observer, reflector, or pruner calls recorded in this session.");
    return lines.join("\n");
  }

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
      `${time} ${call.operation} ${call.provider}/${call.model} ${call.outcome}`,
      usage
        ? `  input ${formatTokens(usage.input)}, cache read ${formatTokens(usage.cacheRead)}, cache write ${formatTokens(usage.cacheWrite)}, output ${formatTokens(usage.output)}, hit ${formatRatio(usage)}`
        : "  usage: unknown",
      `  reported ${formatCost(call.reportedCost?.total)}, estimated ${formatCost(call.estimatedCost?.total)}`,
    );
  }
  return lines.join("\n");
};

export const registerCacheInfoCommand = (pi: ExtensionAPI, telemetry: CacheTelemetry): void => {
  pi.on("session_start", () => {
    telemetry.reset();
  });

  pi.registerCommand("hm-cache-info", {
    description: "Show session-local hybrid-memory cache and cost telemetry",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatCacheInfo(telemetry), "info");
    },
  });
};
