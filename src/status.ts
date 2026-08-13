// Status command: shows hybrid memory status — combines OM and VCC metrics
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Entry, MemoryReflection } from "./types.js";
import {
  getMemoryState,
  rawTokensSinceLastBound,
} from "./om/branch.js";
import { countByRelevance, formatRelevanceHistogram } from "./om/relevance.js";
import { estimateStringTokens } from "./om/tokens.js";
import { reflectionContent } from "./om/compaction.js";
import type { Runtime } from "./runtime.js";

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
  pi.registerCommand("hm-status", {
    description: "Show hybrid memory status",
    handler: async (_args, ctx) => {
      runtime.ensureConfig(ctx.cwd);
      const entries = ctx.sessionManager.getBranch() as Entry[];
      const sinceBound = rawTokensSinceLastBound(entries);

      const { reflections: committedRefs, committedObs, pendingObs } = getMemoryState(entries);
      const committedRefItems = committedRefs as MemoryReflection[];
      const committedObsTokens = committedObs.reduce((s, r) => s + estimateStringTokens(r.content), 0);
      const committedObsCount = committedObs.length;
      const committedRefsTokens = committedRefItems.reduce((s, r) => s + estimateStringTokens(reflectionContent(r)), 0);
      const committedRefsCount = committedRefItems.length;

      const pendingObsTokens = pendingObs.reduce((s, r) => s + estimateStringTokens(r.content), 0);
      const pendingObsCount = pendingObs.length;

      const relevanceHistogram = countByRelevance([...committedObs, ...pendingObs]);

      const obsThreshold = runtime.config.hybrid.observationThresholdTokens;
      const compThreshold = runtime.config.hybrid.compactionThresholdTokens;
      const compPercentage = runtime.config.hybrid.compactionThresholdPercentage;
      const contextUsage = ctx.getContextUsage();
      const refThreshold = runtime.config.hybrid.reflectionThresholdTokens;
      const observationPoolTokens = committedObsTokens + pendingObsTokens;

      const obsPct = Math.min(100, Math.round((sinceBound / obsThreshold) * 100));
      const compPct = contextUsage?.tokens === null || contextUsage?.tokens === undefined
        ? 0
        : Math.min(100, Math.round((contextUsage.tokens / compThreshold) * 100));
      const refPct = Math.min(100, Math.round((observationPoolTokens / refThreshold) * 100));
      const contextTokens = contextUsage?.tokens;
      const nextCompaction = compPercentage !== null
        ? contextTokens === null || contextTokens === undefined
          ? `context usage unavailable / ${compPercentage}%`
          : `${contextTokens.toLocaleString()} / ${(contextUsage?.contextWindow ?? 0).toLocaleString()} tokens (${contextUsage?.percent?.toFixed(1) ?? "?"}% / ${compPercentage}%)`
        : contextTokens === null || contextTokens === undefined
          ? `context usage unavailable / ${compThreshold.toLocaleString()} tokens`
          : `${contextTokens.toLocaleString()} / ${compThreshold.toLocaleString()} tokens (${compPct}%)`;

      const refLabel = committedRefsCount === 1 ? "entry" : "entries";
      const cObsLabel = committedObsCount === 1 ? "observation" : "observations";
      const pObsLabel = pendingObsCount === 1 ? "observation" : "observations";

      const lines = [
        "── Memory ──",
        `Reflections:   ~${committedRefsTokens.toLocaleString()} tokens (${committedRefsCount} ${refLabel})`,
        `Observations:`,
        `  committed    ~${committedObsTokens.toLocaleString()} tokens (${committedObsCount} ${cObsLabel})`,
        `  pending      ~${pendingObsTokens.toLocaleString()} tokens (${pendingObsCount} ${pObsLabel})`,
        `  relevance    ${formatRelevanceHistogram(relevanceHistogram)}`,
        "",
        "── Activity ──",
        `Next observation: ~${sinceBound.toLocaleString()} / ${obsThreshold.toLocaleString()} tokens (${obsPct}%)`,
        `Next compaction:  ${nextCompaction}`,
        `Next reflection:  ~${observationPoolTokens.toLocaleString()} / ${refThreshold.toLocaleString()} tokens (${refPct}%)`,
        "",
        "── VCC Settings ──",
        `Transcript lines: ${runtime.config.hybrid.transcriptLines}`,
        `Max files: ${runtime.config.hybrid.maxFiles}`,
        `Max commits: ${runtime.config.hybrid.maxCommits}`,
        `Max summary: ${runtime.config.hybrid.maxSummaryTokens.toLocaleString()} tokens`,
      ];

      if (runtime.config.hybrid.compactionModel) {
        lines.push(`Compaction model: ${runtime.config.hybrid.compactionModel.provider}/${runtime.config.hybrid.compactionModel.id}`);
      }

      if (runtime.observerInFlight || runtime.compactHookInFlight || runtime.autoCompactionInFlight) {
        lines.push("");
        lines.push("── In flight ──");
        if (runtime.observerInFlight) lines.push("Observer: running");
        if (runtime.compactHookInFlight) lines.push("Compaction: running");
        if (runtime.autoCompactionInFlight) lines.push("Automatic compaction: requested");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
