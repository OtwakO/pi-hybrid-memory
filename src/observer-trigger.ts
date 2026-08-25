// Observer trigger: runs the OM observer at turn_end — ported from pi-observational-memory
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Entry, ObservationEntryData } from "./types.js";
import { OBSERVATION_CUSTOM_TYPE } from "./types.js";
import {
  firstRawIdAfter,
  getMemoryState,
  resolveObservationCoverageAnchor,
  rawTokensSinceLastBound,
  rawTailEntriesBetween,
} from "./om/branch.js";
import { runObserver } from "./om/observer.js";
import { serializeSourceAddressedBranchEntries } from "./om/serialize.js";
import { operationCacheOptions } from "./cache-options.js";
import { estimateStringTokens } from "./om/tokens.js";
import {
  OBSERVER_DELTA_INSTRUCTIONS,
  OBSERVER_FIXED_TOKEN_RESERVE,
  OBSERVER_MINIMUM_DELTA_TOKENS,
  observerBaselineText,
  observerCompatibilityKey,
  observerDeltaText,
  observerEpochTokenLimit,
} from "./om/observer-context.js";
import type { Runtime } from "./runtime.js";

export function registerObserverTrigger(pi: ExtensionAPI, runtime: Runtime): void {
  pi.on("turn_end", (_event, ctx) => {
    runtime.ensureConfig(ctx);
    if (runtime.observerTask.active) return;

    const entries = ctx.sessionManager.getBranch() as Entry[];
    const coverageAnchor = resolveObservationCoverageAnchor(entries);
    const lastBoundIdx = coverageAnchor.coveredSourceIndex;

    // Bootstrap: no observation boundaries exist (first load in existing session).
    // Establish a boundary at the current position — skip the backlog. VCC will
    // handle old content during compaction. Only observe new turns going forward.
    if (lastBoundIdx === -1) {
      const leafId = ctx.sessionManager.getLeafId();
      if (!leafId) return;

      // Find the first raw entry in the last ~30 entries to anchor the boundary.
      // This skips the backlog while ensuring there's at least one raw entry covered.
      const searchFrom = Math.max(0, entries.length - 30);
      const coversFromId = firstRawIdAfter(entries, searchFrom - 1);
      if (!coversFromId) return;

      const data: ObservationEntryData = {
        records: [],
        coversFromId,
        coversUpToId: leafId,
        tokenCount: 0,
      };
      pi.appendEntry(OBSERVATION_CUSTOM_TYPE, data);
      if (ctx.hasUI) ctx.ui.notify(
        "Hybrid memory: bootstrap mode — established observation boundary. Only new turns will be observed.",
        "info",
      );
      return;
    }

    const tokens = rawTokensSinceLastBound(entries);
    const observationThreshold = runtime.config.hybrid.observationThresholdTokens;
    if (tokens < observationThreshold) return;

    const boundaryId = coverageAnchor.coveredSourceId;
    if (!boundaryId) return;
    if (runtime.shouldBackOffEmptyObserver(boundaryId, tokens, observationThreshold)) return;

    const coversFromId = coverageAnchor.sourceProgress?.sourceEntryId
      ?? firstRawIdAfter(entries, lastBoundIdx);
    if (!coversFromId) return;

    const leafId = ctx.sessionManager.getLeafId();
    if (!leafId) return;
    const coversUpToId = leafId;

    const { reflections, committedObs, pendingObs } = getMemoryState(entries, (firstKept) => {
      if (!runtime.boundaryRecoveryNotified && ctx.hasUI && ctx.ui) {
        ctx.ui.notify(`/hm-memory: prior compaction boundary "${firstKept}" not found in this branch — using fallback. Memory preserved; this commonly happens on sessions predating the extension. You can ignore this.`, "info");
        runtime.boundaryRecoveryNotified = true;
      }
    });
    const baselineObservations = [...committedObs, ...pendingObs];

    const chunkEntries = rawTailEntriesBetween(entries, coversFromId, coversUpToId);
    if (chunkEntries.length === 0) return;
    if (ctx.hasUI) ctx.ui.notify(
      `Hybrid memory: observer preparing ~${tokens.toLocaleString()} tokens of pending context`,
      "info",
    );

    void runtime.observerTask.start({
      session: ctx.sessionManager,
      signal: ctx.signal,
      run: async ({ signal, commitSync }) => {
        const resolved = runtime.resolveModel(ctx);
        if (!resolved.ok) {
          if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
            ctx.ui.notify(`Hybrid memory: observer skipped — ${resolved.reason}`, "warning");
            runtime.resolveFailureNotified = true;
          }
          return;
        }
        runtime.resolveFailureNotified = false;

        const model = resolved.model;
        const baselineText = observerBaselineText(reflections, baselineObservations);
        const epochMaxTokens = observerEpochTokenLimit(model, runtime.config.hybrid.observerEpochMaxTokens);
        const freshCapacity = runtime.observerEpoch.freshEpochCapacity({
          baselineText,
          maxTokens: epochMaxTokens,
          fixedTokens: OBSERVER_FIXED_TOKEN_RESERVE,
          deltaOverheadText: OBSERVER_DELTA_INSTRUCTIONS,
          minimumDeltaTokens: OBSERVER_MINIMUM_DELTA_TOKENS,
        });
        runtime.cacheTelemetry.recordObserverCapacity("proactive", freshCapacity);
        if (freshCapacity.pressured) {
          if (ctx.hasUI && ctx.ui) ctx.ui.notify(
            `Hybrid memory: observer baseline pressure leaves only ~${freshCapacity.availableDeltaTokens.toLocaleString()} source tokens; coverage was not advanced.`,
            "warning",
          );
          return;
        }

        const serialized = serializeSourceAddressedBranchEntries(
          chunkEntries,
          Math.min(runtime.config.hybrid.observerChunkMaxTokens, freshCapacity.availableDeltaTokens),
          coverageAnchor.sourceProgress,
        );
        const { text: chunk, sourceEntryIds } = serialized;
        const observedUpToId = serialized.coversUpToId ?? boundaryId;
        if (!chunk.trim() || sourceEntryIds.length === 0) return;

        const prepared = runtime.observerEpoch.prepare({
          compatibilityKey: observerCompatibilityKey(model),
          expectedCoverageId: boundaryId,
          baselineText,
          deltaText: observerDeltaText(chunk, sourceEntryIds),
          maxTokens: epochMaxTokens,
          fixedTokens: OBSERVER_FIXED_TOKEN_RESERVE,
        });
        if (!prepared.ok) {
          if (ctx.hasUI && ctx.ui) ctx.ui.notify(
            `Hybrid memory: observer epoch cannot fit a fresh baseline and source chunk (${prepared.projectedTokens.toLocaleString()} > ${prepared.maxTokens.toLocaleString()} estimated tokens). Coverage was not advanced.`,
            "warning",
          );
          return;
        }

        const result = await runObserver({
          complete: (selectedModel, context, options) =>
            ctx.modelRegistry.complete(selectedModel, context, options),
          model,
          contextMessages: prepared.contextMessages,
          prompts: prepared.prompts,
          allowedSourceEntryIds: sourceEntryIds,
          signal,
          telemetry: runtime.cacheTelemetry,
          cacheOptions: runtime.piSessionId
            ? operationCacheOptions(runtime.piSessionId, "observer")
            : undefined,
          prefixTelemetry: {
            source: "proactive",
            epochRunIndex: prepared.runIndex,
            cold: prepared.cold,
            predictedPrefixTokens: prepared.predictedPrefixTokens,
            projectedTokens: prepared.projectedTokens,
            maxTokens: epochMaxTokens,
            resetReason: prepared.resetReason,
          },
        });
        if (!result.ok) {
          if (ctx.hasUI && ctx.ui) ctx.ui.notify(
            `Hybrid memory: observer failed — ${result.reason}${result.rawResponse ? `\n\nRaw response (first 300 chars):\n${result.rawResponse}` : ""}`,
            "warning",
          );
          return;
        }

        if (result.records.length === 0) {
          if (serialized.hasMore) {
            commitSync(() => {
              runtime.observerEpoch.validateCommit(prepared, result.transcriptSuffix);
              pi.appendEntry(OBSERVATION_CUSTOM_TYPE, {
                records: [],
                coversFromId,
                coversUpToId: observedUpToId,
                tokenCount: 0,
                sourceProgress: serialized.sourceProgress,
              } satisfies ObservationEntryData);
              runtime.observerEpoch.commitValidated(prepared, result.transcriptSuffix, observedUpToId);
            });
            runtime.clearEmptyObserverBackoff();
            if (ctx.hasUI && ctx.ui) ctx.ui.notify(
              "Hybrid memory: observer found nothing in this bounded chunk; coverage advanced and more backlog remains",
              "info",
            );
          } else {
            runtime.recordEmptyObserverResult(boundaryId, tokens);
            if (ctx.hasUI && ctx.ui) ctx.ui.notify(
              "Hybrid memory: observer found nothing worth recording in this chunk; waiting for more context before retrying",
              "info",
            );
          }
          return;
        }

        runtime.clearEmptyObserverBackoff();
        const observationTokens = result.records.reduce(
          (sum, record) => sum + estimateStringTokens(record.content),
          0,
        );
        const data: ObservationEntryData = {
          records: result.records,
          coversFromId,
          coversUpToId: observedUpToId,
          tokenCount: observationTokens,
          sourceProgress: serialized.sourceProgress,
        };
        commitSync(() => {
          runtime.observerEpoch.validateCommit(prepared, result.transcriptSuffix);
          pi.appendEntry(OBSERVATION_CUSTOM_TYPE, data);
          runtime.observerEpoch.commitValidated(prepared, result.transcriptSuffix, observedUpToId);
        });
        if (ctx.hasUI && ctx.ui) ctx.ui.notify(
          `Hybrid memory: ${result.records.length} observation(s) recorded (~${observationTokens.toLocaleString()} tokens)${serialized.hasMore ? "; more backlog remains" : ""}`,
          "info",
        );
      },
    }).then((outcome) => {
      if (outcome.status === "failed" && ctx.hasUI && ctx.ui) {
        const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        ctx.ui.notify(`Hybrid memory: observer task failed — ${message}`, "warning");
      }
    });
  });
}
