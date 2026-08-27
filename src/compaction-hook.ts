// Compaction hook: unified compaction that runs OM observer, VCC summarization, and merges them
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Entry, ObservationEntryData, MemoryReflection, ObservationRecord } from "./types.js";
import { OBSERVATION_CUSTOM_TYPE } from "./types.js";
import {
  collectObservationsByCoverage,
  findLastCompactionIndex,
  gapRawEntries,
  resolveObservationCoverageAnchor,
} from "./om/branch.js";
import { buildBranchMemoryIndex } from "./om/branch-memory-index.js";
import { estimateEntryTokens, estimateStringTokens } from "./om/tokens.js";
import { runObserver } from "./om/observer.js";
import { catchUpProgress } from "./om/compaction-catch-up.js";
import { planObserverContextForSource } from "./om/observer-context-plan.js";
import { prepareObserverSourceRequest } from "./om/observer-request.js";
import {
  OBSERVER_FIXED_TOKEN_RESERVE,
  OBSERVER_MINIMUM_DELTA_TOKENS,
  observerCompatibilityKey,
  observerEpochTokenLimit,
} from "./om/observer-context.js";
import { foldMemory } from "./om/memory-fold.js";
import { createMemoryLifecycleDetails } from "./om/memory-lifecycle.js";
import { createCompletionReflectionModel } from "./om/reflection-model.js";
import { normalize } from "./vcc/normalizer.js";
import { extractGoals, extractFiles, extractCommits, extractPreferences, extractOutstandingContext, formatCommits } from "./vcc/extractor.js";
import { buildBriefSections, stringifyBrief, capBrief } from "./vcc/transcript.js";
import { formatFileActivity, formatVccSections } from "./vcc/formatter.js";
import { mergeVccSummaries } from "./vcc/merger.js";
import { prepareVccCompactionInput } from "./vcc/compaction-input.js";
import { mergePipelines } from "./merge/pipeline.js";
import type { Runtime } from "./runtime.js";
import { operationCacheOptions } from "./cache-options.js";
import {
  advanceFenceAcrossObservationAppends,
  captureSessionBranchFence,
  isSessionBranchFenceCurrent,
} from "./compaction-safety.js";

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
  pi.on("session_before_compact", async (event, ctx) => {
    runtime.ensureConfig(ctx);
    if (!runtime.config.extension.overrideDefaultCompaction) return;

    if (runtime.compactHookInFlight) {
      if (ctx.hasUI) ctx.ui.notify(
        "Hybrid memory: another compaction is already in progress; cancelling duplicate",
        "warning",
      );
      return { cancel: true };
    }
    runtime.compactHookInFlight = true;
    try {
      const { preparation, branchEntries, signal } = event;
      const { firstKeptEntryId } = preparation;
      const tokensBefore = preparation.tokensBefore;

      const resolved = runtime.resolveModel(ctx);
      if (!resolved.ok) {
        if (ctx.hasUI) ctx.ui.notify(
          `Hybrid memory: cannot compact — ${resolved.reason}. Fix the model/API key and try /compact manually.`,
          "error",
        );
        return { cancel: true };
      }
      runtime.resolveFailureNotified = false;

      let entries = branchEntries as Entry[];
      let compactionFence = captureSessionBranchFence(ctx.sessionManager);

      // ── Step 1: Run observer on any gap (catch-up) ──
      if (runtime.observerTask.promise) {
        await runtime.observerTask.promise;
        entries = ctx.sessionManager.getBranch() as Entry[];
        const advancedFence = advanceFenceAcrossObservationAppends(
          compactionFence,
          ctx.sessionManager,
          entries,
          OBSERVATION_CUSTOM_TYPE,
        );
        if (!advancedFence) {
          if (ctx.hasUI) ctx.ui.notify(
            "Hybrid memory: active session or branch changed while waiting for the observer; cancelling stale compaction.",
            "warning",
          );
          return { cancel: true };
        }
        compactionFence = advancedFence;
      }

      const memoryIndex = buildBranchMemoryIndex(entries, { onBoundaryRecovery: (firstKept) => {
        if (!runtime.boundaryRecoveryNotified && ctx.hasUI && ctx.ui) {
          ctx.ui.notify(`/hm-memory: prior compaction boundary "${firstKept}" not found — using fallback. Old session? Existing memory preserved.`, "info");
          runtime.boundaryRecoveryNotified = true;
        }
      } });
      const memoryState = memoryIndex.current;
      let gapObservationData: ObservationEntryData | null = null;
      const gap = gapRawEntries(entries, firstKeptEntryId);

      // ── Bootstrap detection: no prior OM state means fresh install on existing session ──
      const isBootstrap = memoryState.reflections.length === 0 && memoryState.committedObs.length === 0;

      if (gap.length > 0 && !isBootstrap) {
        // Normal mode: one compaction attempt may advance at most one durable
        // observer segment. Remaining backlog is resumed by later proactive work
        // or a later explicit compaction instead of an unbounded provider loop.
        const baselineObservations = [
          ...memoryState.committedObs,
          ...memoryState.pendingObs,
        ];
        const gapTokenEstimate = gap.reduce((sum, entry) => sum + estimateEntryTokens(entry), 0);
        if (ctx.hasUI) ctx.ui.notify(
          `Hybrid memory: sync catch-up observer running one bounded segment on ~${gapTokenEstimate.toLocaleString()}-token gap`,
          "info",
        );

        const draftEpoch = runtime.observerEpoch.fork();
        const coverageAnchor = resolveObservationCoverageAnchor(entries);
        const sourceProgress = coverageAnchor.sourceProgress;
        const expectedCoverageId = coverageAnchor.coveredSourceId ?? firstKeptEntryId;
        try {
          const model = resolved.model;
          const epochMaxTokens = observerEpochTokenLimit(model, runtime.config.hybrid.observerEpochMaxTokens);
          const contextPlan = planObserverContextForSource({
            reflections: memoryState.reflections,
            observations: baselineObservations,
            entries: gap,
            sourceProgress,
            maxTokens: epochMaxTokens,
            sourceMaxTokens: runtime.config.hybrid.observerChunkMaxTokens,
          });
          const request = prepareObserverSourceRequest({
            epoch: draftEpoch,
            compatibilityKey: observerCompatibilityKey(model),
            expectedCoverageId,
            baselineText: contextPlan.stableBaselineText,
            sourceRelatedText: contextPlan.sourceRelatedText,
            entries: gap,
            sourceProgress,
            maxTokens: epochMaxTokens,
            sourceMaxTokens: runtime.config.hybrid.observerChunkMaxTokens,
            fixedTokens: OBSERVER_FIXED_TOKEN_RESERVE,
            minimumSourceTokens: OBSERVER_MINIMUM_DELTA_TOKENS,
          });
          runtime.cacheTelemetry.recordObserverCapacity("catch-up", request.capacity, {
            stableTokens: contextPlan.tokens.stableBaseline,
            sourceRelatedTokens: contextPlan.tokens.sourceRelated,
            stableObservationCount: contextPlan.stableObservations.length,
            sourceRelatedObservationCount: contextPlan.sourceRelatedObservations.length,
            omittedObservationCount: contextPlan.omitted.observations,
            protectedOverflow: contextPlan.protectedOverflow,
          });
          if (!request.ok) {
            if (ctx.hasUI) ctx.ui.notify(
              `Hybrid memory: sync catch-up observer failed: baseline leaves only ${request.capacity.availableDeltaTokens} useful source tokens (${request.capacity.minimumDeltaTokens} required). Cancelling compaction.`,
              "warning",
            );
            return { cancel: true };
          }
          const { serialized, prepared } = request;

          const result = await runObserver({
            complete: (selectedModel, context, options) =>
              ctx.modelRegistry.complete(selectedModel, context, options),
            model,
            contextMessages: prepared.contextMessages,
            prompts: prepared.prompts,
            allowedSourceEntryIds: serialized.sourceEntryIds,
            signal,
            telemetry: runtime.cacheTelemetry,
            cacheOptions: runtime.piSessionId
              ? operationCacheOptions(runtime.piSessionId, "observer")
              : undefined,
            prefixTelemetry: {
              source: "catch-up",
              epochRunIndex: prepared.runIndex,
              cold: prepared.cold,
              predictedPrefixTokens: prepared.predictedPrefixTokens,
              projectedTokens: prepared.projectedTokens,
              maxTokens: epochMaxTokens,
              resetReason: prepared.resetReason,
            },
          });
          if (!result.ok) {
            if (ctx.hasUI) ctx.ui.notify(
              `Hybrid memory: sync catch-up observer failed: ${result.reason}. Cancelling compaction.`,
              "warning",
            );
            return { cancel: true };
          }

          const progress = catchUpProgress(gap, expectedCoverageId, serialized);
          if (!progress.complete && !serialized.sourceProgress && progress.remainingEntries.length === gap.length) {
            if (ctx.hasUI) ctx.ui.notify(
              "Hybrid memory: sync catch-up observer made no durable source progress. Cancelling compaction.",
              "warning",
            );
            return { cancel: true };
          }
          draftEpoch.commit(prepared, result.transcriptSuffix, progress.coveredUpToId);

          if (!isSessionBranchFenceCurrent(compactionFence, ctx.sessionManager)) {
            if (ctx.hasUI) ctx.ui.notify(
              "Hybrid memory: active session or branch changed during catch-up; cancelling compaction without persisting stale observations.",
              "warning",
            );
            return { cancel: true };
          }

          const observationTokens = result.records.reduce(
            (sum, record) => sum + estimateStringTokens(record.content),
            0,
          );
          gapObservationData = {
            records: result.records,
            coversFromId: gap[0].id,
            coversUpToId: progress.coveredUpToId,
            tokenCount: observationTokens,
            sourceProgress: serialized.sourceProgress,
          };
          pi.appendEntry(OBSERVATION_CUSTOM_TYPE, gapObservationData);
          compactionFence = captureSessionBranchFence(ctx.sessionManager);
          runtime.observerEpoch.invalidate("catch-up-persisted");

          if (!progress.complete) {
            const remainingTokens = progress.remainingEntries.reduce(
              (sum, entry) => sum + estimateEntryTokens(entry),
              0,
            );
            if (ctx.hasUI) ctx.ui.notify(
              `Hybrid memory: sync catch-up advanced one durable segment; ~${remainingTokens.toLocaleString()} source tokens remain. Cancelling compaction so later observation can resume safely.`,
              "warning",
            );
            return { cancel: true };
          }

          if (ctx.hasUI) ctx.ui.notify(
            result.records.length > 0
              ? `Hybrid memory: sync catch-up recorded ${result.records.length} observation(s) (~${observationTokens.toLocaleString()} tokens)`
              : "Hybrid memory: sync catch-up examined the complete gap and persisted an empty coverage marker",
            "info",
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(
            `Hybrid memory: sync catch-up observer failed: ${message}. Cancelling compaction.`,
            "warning",
          );
          return { cancel: true };
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
      const workingObservationMap = new Map<string, ObservationRecord>();
      for (const observation of [
        ...memoryState.committedObs,
        ...memoryState.pendingObs,
        ...deltaObservationData.flatMap((data) => data.records),
      ]) {
        if (!workingObservationMap.has(observation.id)) {
          workingObservationMap.set(observation.id, observation);
        }
      }
      const workingObservations = [...workingObservationMap.values()];

      // ── Step 3: Fold semantic memory and retire locally provable exact duplicates ──
      const observationTokens = workingObservations.reduce((sum, o) => sum + estimateStringTokens(o.content), 0);
      if (observationTokens >= runtime.config.hybrid.reflectionThresholdTokens && ctx.hasUI) {
        ctx.ui.notify("Hybrid memory: running reflector before deterministic duplicate retirement...", "info");
      }
      const reflectionModel = createCompletionReflectionModel({
        complete: (model, context, options) => ctx.modelRegistry.complete(model, context, options),
      });
      const fold = await foldMemory({
        params: {
          model: resolved.model,
          signal,
          telemetry: runtime.cacheTelemetry,
          cacheOptions: runtime.piSessionId
            ? operationCacheOptions(runtime.piSessionId, "reflector")
            : undefined,
        },
        reflections: workingReflections,
        observations: workingObservations,
        canonicalObservationIds: new Set([
          ...memoryIndex.activeObservationIds(),
          ...(gapObservationData?.records.map(record => record.id) ?? []),
        ]),
        reflectionThresholdTokens: runtime.config.hybrid.reflectionThresholdTokens,
        targetSummaryTokens: runtime.config.hybrid.maxSummaryTokens,
        modelPort: reflectionModel,
      });
      const finalReflections = fold.reflections;
      const finalObservations = fold.observations;
      if (!fold.ok && ctx.hasUI) {
        ctx.ui.notify(
          `Hybrid memory: reflection failed (${fold.reason}); retained the complete pre-fold memory set`,
          "warning",
        );
      }

      // ── Step 4: Build VCC summary ──
      if (ctx.hasUI) ctx.ui.notify("Hybrid memory: building structural VCC summary...", "info");

      const vccInput = prepareVccCompactionInput(preparation);
      const blocks = normalize(vccInput.messages);
      const sessionGoal = extractGoals(blocks);
      const fileOps = extractFiles(blocks, vccInput.fileOps);
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

      if (vccInput.previousSummary) {
        freshVccSummary = mergeVccSummaries(
          vccInput.previousSummary,
          freshVccSummary,
          runtime.config.hybrid.transcriptLines,
          runtime.config.hybrid.maxFiles,
        );
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
        `Hybrid memory: compaction assembled — ${finalObservations.length} active observations${fold.retirements.length > 0 ? `, ${fold.retirements.length} exact duplicate(s) retired` : ""}, ${finalReflections.length} reflections, ~${merged.tokenCount.toLocaleString()} token summary${merged.protectedOverflow ? " (protected memory exceeds configured ceiling)" : merged.trimmed ? " (trimmed to fit budget)" : ""}`,
        merged.protectedOverflow ? "warning" : "info",
      );

      if (!isSessionBranchFenceCurrent(compactionFence, ctx.sessionManager)) {
        if (ctx.hasUI) ctx.ui.notify(
          "Hybrid memory: active session or branch changed during compaction assembly; cancelling stale compaction.",
          "warning",
        );
        return { cancel: true };
      }

      const lifecycleDetails = createMemoryLifecycleDetails({
        parentMemoryCompactionId: memoryIndex.latestMemoryCompactionId,
        observations: workingObservations,
        previousReflections: workingReflections,
        currentReflections: finalReflections,
        retirements: fold.retirements,
        supersessions: fold.supersessions,
      });

      runtime.observerEpoch.invalidate("compaction");
      return {
        compaction: {
          summary: merged.summary,
          firstKeptEntryId,
          tokensBefore,
          details: lifecycleDetails,
        },
      };
    } finally {
      runtime.compactHookInFlight = false;
    }
  });
}
