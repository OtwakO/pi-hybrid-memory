// Status command: shows hybrid memory status — combines OM and VCC metrics
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Entry } from "./types.js";
import {
  rawTokensSinceLastBound,
} from "./om/branch.js";
import { buildBranchMemoryIndex } from "./om/branch-memory-index.js";
import { countByRelevance, formatRelevanceHistogram } from "./om/relevance.js";
import { buildMemoryMetrics, describeReflectionGate } from "./memory-metrics.js";
import { buildIncrementalReflectionStatus } from "./om/incremental-reflection-status.js";
import { incrementalReflectionCompatibilityVersion } from "./reflection-trigger.js";
import type { Runtime } from "./runtime.js";

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
  pi.registerCommand("hm-status", {
    description: "Show hybrid memory status",
    handler: async (_args, ctx) => {
      runtime.ensureConfig(ctx);
      const entries = ctx.sessionManager.getBranch() as Entry[];
      const sinceBound = rawTokensSinceLastBound(entries);

      const memoryIndex = buildBranchMemoryIndex(entries);
      const memoryState = memoryIndex.current;
      const { committedObs, pendingObs } = memoryState;
      const memoryMetrics = buildMemoryMetrics(memoryState);
      const relevanceHistogram = countByRelevance([...committedObs, ...pendingObs]);

      const obsThreshold = runtime.config.hybrid.observationThresholdTokens;
      const compThreshold = runtime.config.hybrid.compactionThresholdTokens;
      const compPercentage = runtime.config.hybrid.compactionThresholdPercentage;
      const contextUsage = ctx.getContextUsage();
      const refThreshold = runtime.config.hybrid.reflectionThresholdTokens;
      const reflectionGate = describeReflectionGate(memoryMetrics, refThreshold);
      const resolvedReflectionModel = runtime.resolveModel(ctx);
      const incrementalStatus = resolvedReflectionModel.ok
        ? buildIncrementalReflectionStatus({
            entries,
            index: memoryIndex,
            compatibilityVersion: incrementalReflectionCompatibilityVersion(resolvedReflectionModel.model),
            focusObservationTokens: runtime.config.hybrid.maxSummaryTokens,
          })
        : undefined;
      const incrementalCompatibilityUnavailable = resolvedReflectionModel.ok
        ? undefined
        : resolvedReflectionModel.reason;

      const obsPct = Math.min(100, Math.round((sinceBound / obsThreshold) * 100));
      const compPct = contextUsage?.tokens === null || contextUsage?.tokens === undefined
        ? 0
        : Math.min(100, Math.round((contextUsage.tokens / compThreshold) * 100));
      const refPct = Math.min(100, Math.round((memoryMetrics.observationPoolTokens / refThreshold) * 100));
      const contextTokens = contextUsage?.tokens;
      const nextCompaction = compPercentage !== null
        ? contextTokens === null || contextTokens === undefined
          ? `context usage unavailable / ${compPercentage}%`
          : `${contextTokens.toLocaleString()} / ${(contextUsage?.contextWindow ?? 0).toLocaleString()} tokens (${contextUsage?.percent?.toFixed(1) ?? "?"}% / ${compPercentage}%)`
        : contextTokens === null || contextTokens === undefined
          ? `context usage unavailable / ${compThreshold.toLocaleString()} tokens`
          : `${contextTokens.toLocaleString()} / ${compThreshold.toLocaleString()} tokens (${compPct}%)`;

      const refLabel = memoryMetrics.reflectionCount === 1 ? "entry" : "entries";
      const cObsLabel = memoryMetrics.committedObservationCount === 1 ? "observation" : "observations";
      const pObsLabel = memoryMetrics.pendingObservationCount === 1 ? "observation" : "observations";

      const lines = [
        "── Memory ──",
        `Reflections:   ~${memoryMetrics.reflectionTokens.toLocaleString()} tokens (${memoryMetrics.reflectionCount} ${refLabel})`,
        `  reflector    ${reflectionGate.label}`,
        `Observations:`,
        `  committed    ~${memoryMetrics.committedObservationTokens.toLocaleString()} tokens (${memoryMetrics.committedObservationCount} ${cObsLabel})`,
        `  pending      ~${memoryMetrics.pendingObservationTokens.toLocaleString()} tokens (${memoryMetrics.pendingObservationCount} ${pObsLabel})`,
        `  relevance    ${formatRelevanceHistogram(relevanceHistogram)}`,
        "",
        "── Activity ──",
        `Next observation: ~${sinceBound.toLocaleString()} / ${obsThreshold.toLocaleString()} tokens (${obsPct}%)`,
        `Next compaction:  ${nextCompaction}`,
        `Next reflection:  ~${memoryMetrics.observationPoolTokens.toLocaleString()} / ${refThreshold.toLocaleString()} tokens (${refPct}%)`,
        "",
        "── Incremental reflection ──",
        ...(incrementalStatus
          ? [
              `Frontier: ${incrementalStatus.compatibleFrontierEntryId ?? "none for current policy"}`,
              `Journal: ${incrementalStatus.consideredObservationEntries.toLocaleString()} / ${incrementalStatus.totalObservationEntries.toLocaleString()} observation entries considered; ${incrementalStatus.remainingObservationEntries.toLocaleString()} remaining`,
              incrementalStatus.nextWindow.kind === "work"
                ? `Next window: ${incrementalStatus.nextWindow.observationEntryCount} entry(s), ${incrementalStatus.nextWindow.focusObservationCount} active observation(s), through ${incrementalStatus.nextWindow.targetObservationEntryId}`
                : incrementalStatus.nextWindow.kind === "blocked"
                  ? `Next window: blocked at ${incrementalStatus.nextWindow.observationEntryId} (${incrementalStatus.nextWindow.observationCount} active observation(s))`
                  : "Next window: none",
            ]
          : [`Compatibility unavailable: ${incrementalCompatibilityUnavailable}`]),
        "",
        "── VCC Settings ──",
        `Transcript lines: ${runtime.config.hybrid.transcriptLines}`,
        `Max files: ${runtime.config.hybrid.maxFiles}`,
        `Max commits: ${runtime.config.hybrid.maxCommits}`,
        `Max summary: ${runtime.config.hybrid.maxSummaryTokens.toLocaleString()} tokens`,
      ];

      if (memoryIndex.issues.length > 0) {
        lines.push("");
        lines.push("── Memory journal warnings ──");
        lines.push(`${memoryIndex.issues.length} rejected persisted batch(es); prior valid memory retained.`);
        for (const issue of memoryIndex.issues.slice(-3)) {
          lines.push(`  ${issue.entryId}: ${issue.detail}`);
        }
      }

      if (runtime.config.hybrid.compactionModel) {
        lines.push(`Compaction model: ${runtime.config.hybrid.compactionModel.provider}/${runtime.config.hybrid.compactionModel.id}`);
      }

      if (runtime.observerTask.active || runtime.reflectionTask.active || runtime.compactHookInFlight || runtime.autoCompactionInFlight) {
        lines.push("");
        lines.push("── In flight ──");
        if (runtime.observerTask.active) lines.push("Observer: running");
        if (runtime.reflectionTask.active) lines.push("Incremental reflection: running");
        if (runtime.compactHookInFlight) lines.push("Compaction: running");
        if (runtime.autoCompactionInFlight) lines.push("Automatic compaction: requested");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
