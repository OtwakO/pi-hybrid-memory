import { describe, expect, it, vi } from "vitest";

import {
  activeAutoCompactionThreshold,
  registerAutoCompactionTrigger,
} from "../src/auto-compaction.js";
import { validCompactionThresholdPercentage } from "../src/config.js";
import { Runtime } from "../src/runtime.js";

const registeredHandler = () => {
  const on = vi.fn();
  const runtime = new Runtime();
  runtime.loadedConfig = true;
  registerAutoCompactionTrigger({ on } as any, runtime);
  expect(on).toHaveBeenCalledOnce();
  expect(on.mock.calls[0][0]).toBe("agent_settled");
  return { handler: on.mock.calls[0][1], runtime };
};

const context = (tokens: number | null, contextWindow = 100_000) => {
  const compact = vi.fn();
  const notify = vi.fn();
  return {
    ctx: {
      cwd: "/project",
      hasUI: true,
      ui: { notify },
      getContextUsage: () => ({
        tokens,
        contextWindow,
        percent: tokens === null ? null : (tokens / contextWindow) * 100,
      }),
      compact,
    },
    compact,
    notify,
  };
};

describe("automatic compaction threshold", () => {
  it("accepts only finite whole-percentage range values", () => {
    expect(validCompactionThresholdPercentage(1)).toBe(1);
    expect(validCompactionThresholdPercentage(80)).toBe(80);
    expect(validCompactionThresholdPercentage(99)).toBe(99);
    expect(validCompactionThresholdPercentage(0)).toBeNull();
    expect(validCompactionThresholdPercentage(100)).toBeNull();
    expect(validCompactionThresholdPercentage(80.5)).toBeNull();
    expect(validCompactionThresholdPercentage(Number.POSITIVE_INFINITY)).toBeNull();
    expect(validCompactionThresholdPercentage("80")).toBeNull();
  });

  it("uses percentage instead of token threshold when configured", () => {
    const threshold = activeAutoCompactionThreshold(81_000, 100_000, 80, 50_000);

    expect(threshold.kind).toBe("percentage");
    expect(threshold.current).toBe(81);
    expect(threshold.limit).toBe(80);
  });

  it("uses token threshold when percentage is unset", () => {
    const threshold = activeAutoCompactionThreshold(50_001, 1_000_000, null, 50_000);

    expect(threshold.kind).toBe("tokens");
    expect(threshold.current).toBe(50_001);
    expect(threshold.limit).toBe(50_000);
  });

  it("requests compaction after the full agent run exceeds the percentage", () => {
    const { handler, runtime } = registeredHandler();
    runtime.config.hybrid.compactionThresholdPercentage = 80;
    runtime.config.hybrid.compactionThresholdTokens = 50_000;
    const { ctx, compact, notify } = context(81_000);

    handler({}, ctx);

    expect(compact).toHaveBeenCalledOnce();
    expect(runtime.autoCompactionInFlight).toBe(true);
    expect(notify.mock.calls[0][0]).toContain("threshold 80%");
  });

  it("does not trigger at or below the percentage threshold", () => {
    const { handler, runtime } = registeredHandler();
    runtime.config.hybrid.compactionThresholdPercentage = 80;
    const atThreshold = context(80_000);
    const belowThreshold = context(79_999);

    handler({}, atThreshold.ctx);
    handler({}, belowThreshold.ctx);

    expect(atThreshold.compact).not.toHaveBeenCalled();
    expect(belowThreshold.compact).not.toHaveBeenCalled();
  });

  it("falls back to the token trigger when percentage is unset", () => {
    const { handler, runtime } = registeredHandler();
    runtime.config.hybrid.compactionThresholdPercentage = null;
    runtime.config.hybrid.compactionThresholdTokens = 50_000;
    const { ctx, compact } = context(50_001, 1_000_000);

    handler({}, ctx);

    expect(compact).toHaveBeenCalledOnce();
  });

  it("does nothing when the extension compaction override is disabled", () => {
    const { handler, runtime } = registeredHandler();
    runtime.config.extension.overrideDefaultCompaction = false;
    runtime.config.hybrid.compactionThresholdPercentage = 80;
    const { ctx, compact } = context(90_000);

    handler({}, ctx);

    expect(compact).not.toHaveBeenCalled();
  });

  it("does nothing when context usage is unavailable", () => {
    const { handler } = registeredHandler();
    const { ctx, compact } = context(null);

    handler({}, ctx);

    expect(compact).not.toHaveBeenCalled();
  });

  it("suppresses duplicate requests until compaction completes", () => {
    const { handler, runtime } = registeredHandler();
    runtime.config.hybrid.compactionThresholdPercentage = 80;
    const { ctx, compact } = context(90_000);

    handler({}, ctx);
    handler({}, ctx);

    expect(compact).toHaveBeenCalledOnce();
    const options = compact.mock.calls[0][0];
    options.onComplete({});
    expect(runtime.autoCompactionInFlight).toBe(false);

    handler({}, ctx);
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it("clears the duplicate guard after an error", () => {
    const { handler, runtime } = registeredHandler();
    runtime.config.hybrid.compactionThresholdPercentage = 80;
    const { ctx, compact, notify } = context(90_000);

    handler({}, ctx);
    compact.mock.calls[0][0].onError(new Error("failed"));

    expect(runtime.autoCompactionInFlight).toBe(false);
    expect(notify.mock.calls.at(-1)?.[0]).toContain("failed");
  });
});
