// Observer trigger: runs the OM observer at turn_end — ported from pi-observational-memory
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Entry, ObservationEntryData } from "./types.js";
import { OBSERVATION_CUSTOM_TYPE } from "./types.js";
import {
  firstRawIdAfter,
  getMemoryState,
  lastObservationCoverEndIdx,
  rawTokensSinceLastBound,
  rawTailEntriesBetween,
} from "./om/branch.js";
import { observationsToPromptLines, runObserver } from "./om/observer.js";
import { serializeSourceAddressedBranchEntries } from "./om/serialize.js";
import { operationCacheOptions } from "./cache-options.js";
import { estimateStringTokens } from "./om/tokens.js";
import { reflectionContent } from "./om/compaction.js";
import type { Runtime } from "./runtime.js";

export function registerObserverTrigger(pi: ExtensionAPI, runtime: Runtime): void {
  pi.on("turn_end", (_event, ctx) => {
    runtime.ensureConfig(ctx.cwd);
    if (runtime.observerInFlight) return;

    const entries = ctx.sessionManager.getBranch() as Entry[];
    const lastBoundIdx = lastObservationCoverEndIdx(entries);

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

    const boundaryId = entries[lastBoundIdx]?.id;
    if (!boundaryId) return;
    if (runtime.shouldBackOffEmptyObserver(boundaryId, tokens, observationThreshold)) return;

    const coversFromId = firstRawIdAfter(entries, lastBoundIdx);
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
    const priorObservationLines = observationsToPromptLines([...committedObs, ...pendingObs]);

    const chunkEntries = rawTailEntriesBetween(entries, coversFromId, coversUpToId);
    if (chunkEntries.length === 0) return;
    const serialized = serializeSourceAddressedBranchEntries(
      chunkEntries,
      runtime.config.hybrid.observerChunkMaxTokens,
    );
    const { text: chunk, sourceEntryIds, coversUpToId: observedUpToId } = serialized;
    if (!chunk.trim() || sourceEntryIds.length === 0 || !observedUpToId) return;

    if (ctx.hasUI) ctx.ui.notify(
      `Hybrid memory: observer running on ~${tokens.toLocaleString()}-token chunk`,
      "info",
    );

    void runtime.launchObserverTask(ctx, "observer", async () => {
      const resolved = await runtime.resolveModel(ctx as any);
      if (!resolved.ok) {
        if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
          ctx.ui.notify(`Hybrid memory: observer skipped — ${resolved.reason}`, "warning");
          runtime.resolveFailureNotified = true;
        }
        return;
      }
      runtime.resolveFailureNotified = false;

      const result = await runObserver({
        model: resolved.model as any,
        apiKey: resolved.apiKey,
        headers: resolved.headers,
        priorReflections: reflections.map(r => reflectionContent(r)),
        priorObservations: priorObservationLines,
        chunk,
        allowedSourceEntryIds: sourceEntryIds,
        telemetry: runtime.cacheTelemetry,
        cacheOptions: runtime.piSessionId
          ? operationCacheOptions(runtime.piSessionId, "observer")
          : undefined,
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
          pi.appendEntry(OBSERVATION_CUSTOM_TYPE, {
            records: [],
            coversFromId,
            coversUpToId: observedUpToId,
            tokenCount: 0,
          } satisfies ObservationEntryData);
          runtime.clearEmptyObserverBackoff();
          if (ctx.hasUI && ctx.ui) ctx.ui.notify("Hybrid memory: observer found nothing in this bounded chunk; coverage advanced and more backlog remains", "info");
        } else {
          runtime.recordEmptyObserverResult(boundaryId, tokens);
          if (ctx.hasUI && ctx.ui) ctx.ui.notify("Hybrid memory: observer found nothing worth recording in this chunk; waiting for more context before retrying", "info");
        }
        return;
      }

      runtime.clearEmptyObserverBackoff();
      const observationTokens = result.records.reduce((sum, r) => sum + estimateStringTokens(r.content), 0);
      const data: ObservationEntryData = {
        records: result.records,
        coversFromId,
        coversUpToId: observedUpToId,
        tokenCount: observationTokens,
      };
      pi.appendEntry(OBSERVATION_CUSTOM_TYPE, data);
      if (ctx.hasUI && ctx.ui) ctx.ui.notify(
        `Hybrid memory: ${result.records.length} observation(s) recorded (~${observationTokens.toLocaleString()} tokens)${serialized.hasMore ? "; more backlog remains" : ""}`,
        "info",
      );
    });
  });
}
