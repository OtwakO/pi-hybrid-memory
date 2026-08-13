import { describe, expect, it, vi } from "vitest";

import { CacheTelemetry, formatCacheInfo } from "../src/cache-telemetry.js";

const model = {
  provider: "test-provider",
  id: "test-model",
  cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2.5 },
} as any;

const usage = (overrides: Record<string, unknown> = {}) => ({
  input: 1_000,
  output: 100,
  cacheRead: 3_000,
  cacheWrite: 500,
  totalTokens: 4_600,
  cost: { input: 0.002, output: 0.0008, cacheRead: 0.0015, cacheWrite: 0.00125, total: 0.00555 },
  ...overrides,
}) as any;

describe("CacheTelemetry", () => {
  it("keeps whole-session aggregates while bounding recent calls", () => {
    const telemetry = new CacheTelemetry(2);
    telemetry.record("observer", model, "success", usage(), 1);
    telemetry.record("observer", model, "error", usage(), 2);
    telemetry.record("observer", model, "success", usage(), 3);

    expect(telemetry.calls().map((call) => call.timestamp)).toEqual([2, 3]);
    const aggregate = telemetry.aggregates().find((item) => item.operation === "observer")!;
    expect(aggregate.calls).toBe(3);
    expect(aggregate.successfulCalls).toBe(2);
    expect(aggregate.failedCalls).toBe(1);
    expect(aggregate.usage.cacheRead).toBe(9_000);
  });

  it("shows provider-reported and independently estimated costs", () => {
    const telemetry = new CacheTelemetry();
    telemetry.record("reflector", model, "success", usage(), Date.UTC(2026, 0, 1));

    const call = telemetry.calls()[0];
    expect(call.reportedCost?.total).toBeCloseTo(0.00555);
    expect(call.estimatedCost?.total).toBeCloseTo(0.00555);

    const output = formatCacheInfo(telemetry);
    expect(output).toContain("provider-reported cost: $0.005550");
    expect(output).toContain("price-based estimate: $0.005550");
    expect(output).toContain("cache read ratio: 75.0%");
  });

  it("shows unknown instead of zero when usage or pricing is unavailable", () => {
    const telemetry = new CacheTelemetry();
    telemetry.record("pruner", { ...model, cost: undefined } as any, "aborted", undefined, 1);

    const output = formatCacheInfo(telemetry);
    expect(output).toContain("usage: unknown");
    expect(output).toContain("provider-reported cost: unknown");
    expect(output).toContain("price-based estimate: unknown");
  });

  it("resets both recent calls and whole-session aggregates", () => {
    const telemetry = new CacheTelemetry();
    telemetry.record("observer", model, "success", usage(), 1);

    telemetry.reset();

    expect(telemetry.calls()).toEqual([]);
    expect(telemetry.aggregates().find((item) => item.operation === "observer")?.calls).toBe(0);
  });

  it("starts with a clear empty-session message", () => {
    expect(formatCacheInfo(new CacheTelemetry())).toContain("No observer, reflector, or pruner calls recorded");
  });
});
