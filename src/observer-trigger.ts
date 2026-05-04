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
import { estimateStringTokens } from "./om/tokens.js";
import { reflectionContent } from "./om/compaction.js";
import type { Runtime } from "./runtime.js";

export function registerObserverTrigger(pi: ExtensionAPI, runtime: Runtime): void {
  pi.on("turn_end", (_event, ctx) => {
    runtime.ensureConfig(ctx.cwd);
    if (runtime.observerInFlight) return;

    const entries = ctx.sessionManager.getBranch() as Entry[];
    const tokens = rawTokensSinceLastBound(entries);
    if (tokens < runtime.config.hybrid.observationThresholdTokens) return;

    const lastBoundIdx = lastObservationCoverEndIdx(entries);
    const coversFromId = firstRawIdAfter(entries, lastBoundIdx);
    if (!coversFromId) return;

    const leafId = ctx.sessionManager.getLeafId();
    if (!leafId) return;
    const coversUpToId = leafId;

    const { reflections, committedObs, pendingObs } = getMemoryState(entries);
    const priorObservationLines = observationsToPromptLines([...committedObs, ...pendingObs]);

    const chunkEntries = rawTailEntriesBetween(entries, coversFromId, coversUpToId);
    if (chunkEntries.length === 0) return;
    const { text: chunk, sourceEntryIds } = serializeSourceAddressedBranchEntries(chunkEntries);
    if (!chunk.trim() || sourceEntryIds.length === 0) return;

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

      const records = await runObserver({
        model: resolved.model as any,
        apiKey: resolved.apiKey,
        headers: resolved.headers,
        priorReflections: reflections.map(r => reflectionContent(r)),
        priorObservations: priorObservationLines,
        chunk,
        allowedSourceEntryIds: sourceEntryIds,
      });
      if (!records || records.length === 0) {
        if (ctx.hasUI && ctx.ui) ctx.ui.notify("Hybrid memory: observer returned no observations", "warning");
        return;
      }

      const observationTokens = records.reduce((sum, r) => sum + estimateStringTokens(r.content), 0);
      const data: ObservationEntryData = {
        records,
        coversFromId,
        coversUpToId,
        tokenCount: observationTokens,
      };
      pi.appendEntry(OBSERVATION_CUSTOM_TYPE, data);
      if (ctx.hasUI && ctx.ui) ctx.ui.notify(
        `Hybrid memory: ${records.length} observation(s) recorded (~${observationTokens.toLocaleString()} tokens)`,
        "info",
      );
    });
  });
}
