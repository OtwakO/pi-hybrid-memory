import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "./runtime.js";

export interface AutoCompactionThreshold {
  kind: "percentage" | "tokens";
  limit: number;
  current: number;
  label: string;
}

export const activeAutoCompactionThreshold = (
  tokens: number,
  contextWindow: number,
  percentage: number | null,
  tokenThreshold: number,
): AutoCompactionThreshold => {
  if (percentage !== null) {
    return {
      kind: "percentage",
      limit: percentage,
      current: contextWindow > 0 ? (tokens / contextWindow) * 100 : 0,
      label: `${percentage}% of ${contextWindow.toLocaleString()} tokens`,
    };
  }

  return {
    kind: "tokens",
    limit: tokenThreshold,
    current: tokens,
    label: `${tokenThreshold.toLocaleString()} tokens`,
  };
};

export function registerAutoCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
  pi.on("agent_settled", (_event, ctx) => {
    runtime.ensureConfig(ctx.cwd, ctx.isProjectTrusted());
    if (!runtime.config.extension.overrideDefaultCompaction) return;
    if (runtime.autoCompactionInFlight || runtime.compactHookInFlight) return;

    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null) return;

    const threshold = activeAutoCompactionThreshold(
      usage.tokens,
      usage.contextWindow,
      runtime.config.hybrid.compactionThresholdPercentage,
      runtime.config.hybrid.compactionThresholdTokens,
    );
    if (threshold.current <= threshold.limit) return;

    runtime.autoCompactionInFlight = true;
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Hybrid memory: auto-compacting at ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${usage.percent?.toFixed(1) ?? "?"}%; threshold ${threshold.label})`,
        "info",
      );
    }

    ctx.compact({
      onComplete: () => {
        runtime.autoCompactionInFlight = false;
        if (ctx.hasUI) ctx.ui.notify("Hybrid memory: automatic compaction completed", "info");
      },
      onError: (error: Error) => {
        runtime.autoCompactionInFlight = false;
        if (ctx.hasUI) ctx.ui.notify(`Hybrid memory: automatic compaction failed — ${error.message}`, "error");
      },
    });
  });
}
