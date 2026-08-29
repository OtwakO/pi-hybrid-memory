import type { Api, Model } from "@earendil-works/pi-ai";

import { operationCacheOptions } from "./cache-options.js";
import { processNextReflectionWindow } from "./om/incremental-reflection-processor.js";
import { foldMemory } from "./om/memory-fold.js";
import { DEFAULT_REFLECTION_HISTORY_BUDGETS } from "./om/reflection-context-plan.js";
import { createCompletionReflectionModel } from "./om/reflection-model.js";
import type { Runtime } from "./runtime.js";
import type { Entry } from "./types.js";

export const INCREMENTAL_REFLECTION_POLICY_VERSION = "incremental-reflection-v1-bounded-handles";

export const incrementalReflectionCompatibilityVersion = (model: Model<Api>): string => [
  model.provider,
  model.api,
  model.id,
  INCREMENTAL_REFLECTION_POLICY_VERSION,
].join("|");

interface ReflectionTriggerContext {
  hasUI: boolean;
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
  model?: Model<Api>;
  modelRegistry: {
    find(provider: string, id: string): Model<Api> | undefined;
    complete: Parameters<typeof createCompletionReflectionModel>[0]["complete"];
  };
  sessionManager: {
    getSessionId(): string | undefined;
    getLeafId(): string | null | undefined;
    getBranch(): Entry[];
  };
}

export const startIncrementalReflection = (
  appendEntry: (customType: string, data: unknown) => void,
  runtime: Runtime,
  ctx: ReflectionTriggerContext,
): void => {
  void runtime.reflectionTask.start(async signal => {
    try {
      const resolved = runtime.resolveModel(ctx);
      if (!resolved.ok) return false;
      const model = resolved.model;
      const result = await processNextReflectionWindow({
        session: ctx.sessionManager,
        appendEntry,
        compatibilityVersion: incrementalReflectionCompatibilityVersion(model),
        focusObservationTokens: runtime.config.hybrid.maxSummaryTokens,
        fold: foldMemory,
        foldInput: {
          params: {
            model,
            signal,
            telemetry: runtime.cacheTelemetry,
            cacheOptions: runtime.piSessionId
              ? operationCacheOptions(runtime.piSessionId, "reflector")
              : undefined,
          },
          contextBudgets: {
            ...DEFAULT_REFLECTION_HISTORY_BUDGETS,
            focusObservationTokens: runtime.config.hybrid.maxSummaryTokens,
          },
          reflectionThresholdTokens: runtime.config.hybrid.reflectionThresholdTokens,
          targetSummaryTokens: runtime.config.hybrid.maxSummaryTokens,
          modelPort: createCompletionReflectionModel({
            complete: (selectedModel, context, options) =>
              ctx.modelRegistry.complete(selectedModel, context, options),
          }),
        },
      });
      runtime.cacheTelemetry.recordIncrementalReflectionOutcome({
        outcome: result.outcome,
        ...(result.outcome === "persisted" ? { foldOutcome: result.foldOutcome } : {}),
        ...(result.outcome === "blocked"
          ? { blockedObservationCount: result.observationCount }
          : {}),
        ...("reason" in result ? { reason: result.reason } : {}),
      });
      if (result.outcome === "blocked" && ctx.hasUI) {
        ctx.ui.notify(
          `Hybrid memory: incremental reflection is blocked by observation entry ${result.observationEntryId} (${result.observationCount} active observation(s)) that exceeds the bounded focus budget. Evidence remains active and recallable.`,
          "warning",
        );
      }
      const permitAutomaticRerun = result.outcome !== "failed" && result.outcome !== "blocked";
      if (!permitAutomaticRerun) runtime.cacheTelemetry.markReflectionAutomaticRerunSuppressed();
      return permitAutomaticRerun;
    } catch (error) {
      if (!signal.aborted && ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Hybrid memory: incremental reflection task failed — ${message}`, "warning");
      }
      return false;
    }
  });
};
