// Compaction hook: unified compaction that runs OM observer, VCC summarization, and merges them
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Entry, ObservationEntryData, MemoryReflection, ObservationRecord } from "./types.js";
import { OBSERVATION_CUSTOM_TYPE } from "./types.js";
import {
  collectObservationsByCoverage,
  findLastCompactionIndex,
  gapRawEntries,
  getMemoryState,
} from "./om/branch.js";
import { estimateEntryTokens, estimateStringTokens } from "./om/tokens.js";
import { serializeSourceAddressedBranchEntries } from "./om/serialize.js";
import { observationsToPromptLines, runObserver } from "./om/observer.js";
import { runPruner, runReflector, reflectionContent, deriveCoverageTags } from "./om/compaction.js";
import { normalize } from "./vcc/normalizer.js";
import { extractGoals, extractFiles, extractCommits, extractPreferences, extractOutstandingContext, formatCommits } from "./vcc/extractor.js";
import { buildBriefSections, stringifyBrief, capBrief } from "./vcc/transcript.js";
import { formatFileActivity, formatVccSections } from "./vcc/formatter.js";
import { mergeVccSummaries } from "./vcc/merger.js";
import { mergePipelines } from "./merge/pipeline.js";
import type { Runtime } from "./runtime.js";
import { operationCacheOptions } from "./cache-options.js";
import type { Message } from "@mariozechner/pi-ai";

export const vccMessagesFromEntries = (entries: Entry[]): Message[] => {
  const messages: Message[] = [];
  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      messages.push(entry.message as Message);
    } else if (
      entry.type === "custom_message" &&
      (typeof entry.content === "string" || Array.isArray(entry.content))
    ) {
      messages.push({
        role: "user",
        content: entry.content,
        timestamp: new Date(entry.timestamp ?? 0).getTime(),
      } as Message);
    } else if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      messages.push({
        role: "user",
        content: `Branch summary:\n${entry.summary}`,
        timestamp: new Date(entry.timestamp ?? 0).getTime(),
      } as Message);
    }
  }
  return messages;
};

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
  pi.on("session_before_compact", async (event, ctx) => {
    if (runtime.compactHookInFlight) {
      if (ctx.hasUI) ctx.ui.notify(
        "Hybrid memory: another compaction is already in progress; cancelling duplicate",
        "warning",
      );
      return { cancel: true };
    }
    runtime.compactHookInFlight = true;
    try {
      runtime.ensureConfig(ctx.cwd);
      const { preparation, branchEntries, signal } = event;
      const { firstKeptEntryId } = preparation;
      const tokensBefore = preparation.tokensBefore;

      const resolved = await runtime.resolveModel(ctx as any);
      if (!resolved.ok) {
        if (ctx.hasUI) ctx.ui.notify(
          `Hybrid memory: cannot compact — ${resolved.reason}. Fix the model/API key and try /compact manually.`,
          "error",
        );
        return { cancel: true };
      }
      runtime.resolveFailureNotified = false;

      let entries = branchEntries as Entry[];

      // ── Step 1: Run observer on any gap (catch-up) ──
      if (runtime.observerPromise) {
        try { await runtime.observerPromise; } catch { /* already notified */ }
        entries = ctx.sessionManager.getBranch() as Entry[];
      }

      const memoryState = getMemoryState(entries, (firstKept) => {
        if (!runtime.boundaryRecoveryNotified && ctx.hasUI && ctx.ui) {
          ctx.ui.notify(`/hm-memory: prior compaction boundary "${firstKept}" not found — using fallback. Old session? Existing memory preserved.`, "info");
          runtime.boundaryRecoveryNotified = true;
        }
      });
      let gapObservationData: ObservationEntryData | null = null;
      const gap = gapRawEntries(entries, firstKeptEntryId);

      // ── Bootstrap detection: no prior OM state means fresh install on existing session ──
      const isBootstrap = memoryState.reflections.length === 0 && memoryState.committedObs.length === 0;

      if (gap.length > 0 && !isBootstrap) {
        // Normal mode: process the entire gap in bounded chunks before allowing
        // compaction. This preserves fail-closed coverage without sending one
        // unbounded observer request.
        const priorObservationLines = observationsToPromptLines([
          ...memoryState.committedObs,
          ...memoryState.pendingObs,
        ]);
        const gapTokenEstimate = gap.reduce((sum, entry) => sum + estimateEntryTokens(entry), 0);
        if (ctx.hasUI) ctx.ui.notify(
          `Hybrid memory: sync catch-up observer running on ~${gapTokenEstimate.toLocaleString()}-token gap`,
          "info",
        );

        runtime.observerInFlight = true;
        const accumulatedRecords: ObservationRecord[] = [];
        let remainingGap = gap;
        let gapFailedReason: string | null = null;
        try {
          while (remainingGap.length > 0) {
            const serialized = serializeSourceAddressedBranchEntries(
              remainingGap,
              runtime.config.hybrid.observerChunkMaxTokens,
            );
            if (!serialized.text.trim() || serialized.sourceEntryIds.length === 0 || !serialized.coversUpToId) {
              gapFailedReason = "could not serialize the remaining source entries within the observer budget";
              break;
            }

            const result = await runObserver({
              model: resolved.model as any,
              apiKey: resolved.apiKey,
              headers: resolved.headers,
              priorReflections: memoryState.reflections.map(r => reflectionContent(r)),
              priorObservations: [
                ...priorObservationLines,
                ...observationsToPromptLines(accumulatedRecords),
              ],
              chunk: serialized.text,
              allowedSourceEntryIds: serialized.sourceEntryIds,
              signal,
              telemetry: runtime.cacheTelemetry,
              cacheOptions: runtime.piSessionId
                ? operationCacheOptions(runtime.piSessionId, "observer")
                : undefined,
            });
            if (!result.ok) {
              gapFailedReason = result.reason;
              break;
            }
            accumulatedRecords.push(...result.records);

            const coveredIndex = remainingGap.findIndex(entry => entry.id === serialized.coversUpToId);
            if (coveredIndex < 0) {
              gapFailedReason = `observer coverage marker ${serialized.coversUpToId} was not found in the remaining gap`;
              break;
            }
            remainingGap = remainingGap.slice(coveredIndex + 1);
          }

          if (gapFailedReason) {
            if (ctx.hasUI) ctx.ui.notify(
              `Hybrid memory: sync catch-up observer failed: ${gapFailedReason}. Cancelling compaction.`,
              "warning",
            );
            return { cancel: true };
          }

          if (accumulatedRecords.length > 0) {
            const observationTokens = accumulatedRecords.reduce((sum, record) => sum + estimateStringTokens(record.content), 0);
            gapObservationData = {
              records: accumulatedRecords,
              coversFromId: gap[0].id,
              coversUpToId: gap[gap.length - 1].id,
              tokenCount: observationTokens,
            };
            pi.appendEntry(OBSERVATION_CUSTOM_TYPE, gapObservationData);
            if (ctx.hasUI) ctx.ui.notify(
              `Hybrid memory: sync catch-up recorded ${accumulatedRecords.length} observation(s) (~${observationTokens.toLocaleString()} tokens)`,
              "info",
            );
          } else if (ctx.hasUI) {
            ctx.ui.notify("Hybrid memory: sync catch-up examined the full gap and found nothing worth recording", "info");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(
            `Hybrid memory: sync catch-up observer failed: ${message}. Cancelling compaction.`,
            "warning",
          );
          return { cancel: true };
        } finally {
          runtime.observerInFlight = false;
          runtime.observerPromise = null;
        }
      } else if (gap.length > 0 && isBootstrap) {
        // Bootstrap mode: skip gap observer — VCC will handle structural summary of old content
        if (ctx.hasUI) ctx.ui.notify(
          `Hybrid memory: bootstrap mode — skipping observer on ~${gap.reduce((s, e) => s + estimateEntryTokens(e), 0).toLocaleString()}-token backlog. VCC will summarize old content during compaction.`,
          "info",
        );
      }

      // ── Step 2: Collect delta observations ──
      const priorCompactionIdx = findLastCompactionIndex(entries);
      const priorFirstKeptEntryId = priorCompactionIdx >= 0 ? entries[priorCompactionIdx].firstKeptEntryId : undefined;
      const deltaObservationData = collectObservationsByCoverage(entries, priorFirstKeptEntryId, firstKeptEntryId, (firstKept) => {
        if (!runtime.boundaryRecoveryNotified && ctx.hasUI && ctx.ui) {
          ctx.ui.notify(`/hm-memory: prior compaction boundary "${firstKept}" not found — using fallback. Old session? Existing memory preserved.`, "info");
          runtime.boundaryRecoveryNotified = true;
        }
      });
      if (gapObservationData) deltaObservationData.push(gapObservationData);

      if (deltaObservationData.length === 0) {
        // No new observations — but we still need to produce a VCC summary
        if (ctx.hasUI) ctx.ui.notify("Hybrid memory: no new observations; building VCC summary only", "info");
      }

      const workingReflections: MemoryReflection[] = [...memoryState.reflections];
      const workingObservations: ObservationRecord[] = [
        ...memoryState.committedObs,
        ...deltaObservationData.flatMap((d) => d.records),
      ];

      // ── Step 3: Run reflector/pruner if needed ──
      const observationTokens = workingObservations.reduce((sum, o) => sum + estimateStringTokens(o.content), 0);
      let finalReflections = workingReflections;
      let finalObservations = workingObservations;

      if (observationTokens >= runtime.config.hybrid.reflectionThresholdTokens) {
        if (ctx.hasUI) ctx.ui.notify("Hybrid memory: running reflector + pruner...", "info");
        try {
          finalReflections = await runReflector(
            {
              model: resolved.model as any,
              apiKey: resolved.apiKey,
              headers: resolved.headers,
              signal,
              telemetry: runtime.cacheTelemetry,
              cacheOptions: runtime.piSessionId
                ? operationCacheOptions(runtime.piSessionId, "reflector")
                : undefined,
            },
            workingReflections,
            workingObservations,
          );
          const coverageTags = deriveCoverageTags(finalReflections, workingObservations);
          const prunerResult = await runPruner(
            {
              model: resolved.model as any,
              apiKey: resolved.apiKey,
              headers: resolved.headers,
              signal,
              telemetry: runtime.cacheTelemetry,
              cacheOptions: runtime.piSessionId
                ? operationCacheOptions(runtime.piSessionId, "pruner")
                : undefined,
            },
            finalReflections,
            workingObservations,
            runtime.config.hybrid.reflectionThresholdTokens,
            coverageTags,
          );
          finalObservations = prunerResult.observations;
          if (prunerResult.fellBack && ctx.hasUI) {
            ctx.ui.notify("Hybrid memory: pruner run failed; kept observation set unchanged", "warning");
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`Hybrid memory: reflect/prune failed: ${msg}`, "warning");
        }
      }

      // ── Step 4: Build VCC summary ──
      if (ctx.hasUI) ctx.ui.notify("Hybrid memory: building structural VCC summary...", "info");

      // Extract from branch entries since last compaction
      const tailStart = priorCompactionIdx >= 0 ? liveTailStartIndex(entries) : 0;
      const tailEntries = entries.slice(tailStart);
      const tailMessages = vccMessagesFromEntries(tailEntries);

      const blocks = normalize(tailMessages);
      const sessionGoal = extractGoals(blocks);
      const fileOps = extractFiles(blocks, preparation.fileOps);
      const commits = extractCommits(blocks);
      const preferences = extractPreferences(blocks);
      const outstandingContext = extractOutstandingContext(blocks);
      const briefSections = buildBriefSections(blocks, runtime.config.hybrid.transcriptLines);
      const briefText = capBrief(stringifyBrief(briefSections), runtime.config.hybrid.transcriptLines);

      const fileLines = formatFileActivity(fileOps, runtime.config.hybrid.maxFiles);

      const vccSectionData = {
        sessionGoal,
        filesAndChanges: fileLines,
        commits: formatCommits(commits, runtime.config.hybrid.maxCommits),
        outstandingContext,
        userPreferences: preferences,
        briefTranscript: briefText,
      };

      let freshVccSummary = formatVccSections(vccSectionData);

      // Merge with prior VCC summary if exists
      const prevSummary = preparation.previousSummary;
      if (prevSummary) {
        // Extract the VCC section from the previous summary (after the --- separator if present)
        const vccSeparator = "\n\n---\n\n";
        const prevVccIdx = prevSummary.indexOf(vccSeparator);
        const prevVccPart = prevVccIdx >= 0 ? prevSummary.slice(prevVccIdx + vccSeparator.length) : "";
        // Try to identify VCC section — it's the part after "## Session State"
        const sessionStateIdx = prevVccPart.indexOf("## Session State");
        const prevVccCore = sessionStateIdx >= 0 ? prevVccPart.slice(sessionStateIdx) : prevVccPart;
        if (prevVccCore.trim()) {
          freshVccSummary = mergeVccSummaries(
            prevVccCore,
            freshVccSummary,
            runtime.config.hybrid.transcriptLines,
            runtime.config.hybrid.maxFiles,
          );
        }
      }

      // ── Step 5: Merge OM + VCC into unified summary ──
      const merged = mergePipelines({
        observations: finalObservations,
        reflections: finalReflections,
        vccSummary: freshVccSummary,
        settings: {
          maxSummaryTokens: runtime.config.hybrid.maxSummaryTokens,
        },
      });

      if (ctx.hasUI) ctx.ui.notify(
        `Hybrid memory: compaction assembled — ${finalObservations.length} observations, ${finalReflections.length} reflections, ~${merged.tokenCount.toLocaleString()} token summary${merged.protectedOverflow ? " (protected memory exceeds configured ceiling)" : merged.trimmed ? " (trimmed to fit budget)" : ""}`,
        merged.protectedOverflow ? "warning" : "info",
      );

      return {
        compaction: {
          summary: merged.summary,
          firstKeptEntryId,
          tokensBefore,
          details: merged.details,
        },
      };
    } finally {
      runtime.compactHookInFlight = false;
    }
  });
}

const liveTailStartIndex = (entries: Entry[]): number => {
  const compactionIdx = findLastCompactionIndex(entries);
  if (compactionIdx === -1) return 0;
  const firstKept = entries[compactionIdx].firstKeptEntryId;
  if (!firstKept) return 0;
  const firstKeptIdx = entries.findIndex((e) => e.id === firstKept);
  if (firstKeptIdx === -1) return 0;
  return firstKeptIdx;
};
