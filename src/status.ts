// Status command: shows hybrid memory status — combines OM and VCC metrics
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { Entry, MemoryReflection } from "./types.js";
import {
  getMemoryState,
  rawTokensSinceLastBound,
  rawTokensSinceLastCompaction,
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
      const sinceCompaction = rawTokensSinceLastCompaction(entries);

      const { reflections: committedRefs, committedObs, pendingObs } = getMemoryState(entries);
      const committedRefItems = committedRefs as MemoryReflection[];
      const committedObsTokens = committedObs.reduce((s, r) => s + estimateStringTokens(r.content), 0);
      const committedObsCount = committedObs.length;
      const committedRefsTokens = committedRefItems.reduce((s, r) => s + estimateStringTokens(reflectionContent(r)), 0);
      const committedRefsCount = committedRefItems.length;

      const pendingObsTokens = pendingObs.reduce((s, r) => s + estimateStringTokens(r.content), 0);
      const pendingObsCount = pendingObs.length;

      const relevanceHistogram = countByRelevance([...committedObs, ...pendingObs]);
      const keepRecentTokens = SettingsManager.create(ctx.cwd).getCompactionKeepRecentTokens();

      const obsThreshold = runtime.config.hybrid.observationThresholdTokens;
      const compThreshold = runtime.config.hybrid.compactionThresholdTokens;
      const refThreshold = runtime.config.hybrid.reflectionThresholdTokens;
      const observationPoolTokens = committedObsTokens + pendingObsTokens;

      const obsPct = Math.min(100, Math.round((sinceBound / obsThreshold) * 100));
      const compPct = Math.min(100, Math.round((sinceCompaction / compThreshold) * 100));
      const refPct = Math.min(100, Math.round((observationPoolTokens / refThreshold) * 100));

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
        `Next compaction:  ~${sinceCompaction.toLocaleString()} / ${compThreshold.toLocaleString()} tokens (${compPct}%)`,
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

      if (runtime.observerInFlight || runtime.compactHookInFlight) {
        lines.push("");
        lines.push("── In flight ──");
        if (runtime.observerInFlight) lines.push("Observer: running");
        if (runtime.compactHookInFlight) lines.push("Compaction: running");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
