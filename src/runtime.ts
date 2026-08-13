// Runtime: holds config, in-flight state, and model resolution
import type { ExtensionConfig, HybridSettings, ResolveResult, UnifiedConfig } from "./types.js";
import { loadConfig } from "./config.js";

export class Runtime {
  config: UnifiedConfig;
  loadedConfig = false;

  // In-flight state
  observerInFlight = false;
  compactHookInFlight = false;
  autoCompactionInFlight = false;
  resolveFailureNotified = false;
  observerPromise: Promise<void> | null = null;

  // One-shot notice: set when we've surfaced the "old compaction boundary
  // unresolved" recovery notice. Only the first firing after a (re)load should
  // notify the user; subsequent fires within the same session stay silent.
  // Reset explicitly only by re-instantiation (process restart).
  boundaryRecoveryNotified = false;

  constructor() {
    this.config = {
      extension: { overrideDefaultCompaction: true, debug: false },
      hybrid: {
        observationThresholdTokens: 1000,
        compactionThresholdTokens: 50000,
        compactionThresholdPercentage: null,
        reflectionThresholdTokens: 30000,
        compactionModel: null,
        transcriptLines: 120,
        maxFiles: 40,
        maxCommits: 8,
        maxSummaryTokens: 16000,
      },
    };
  }

  ensureConfig(cwd: string, notify?: (msg: string, level?: "info" | "warning" | "error") => void): void {
    if (!this.loadedConfig) {
      this.config = loadConfig(cwd, notify);
      this.loadedConfig = true;
    }
  }

  async resolveModel(ctx: {
    model: unknown;
    modelRegistry: {
      find: (provider: string, id: string) => unknown | undefined;
      getApiKeyAndHeaders: (model: unknown) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string> }>;
    };
  }): Promise<ResolveResult> {
    const overrideModel = this.config.hybrid.compactionModel;
    if (overrideModel) {
      const model = ctx.modelRegistry.find(overrideModel.provider, overrideModel.id);
      if (!model) {
        return { ok: false, reason: `configured compaction model ${overrideModel.provider}/${overrideModel.id} not found` };
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) return { ok: false, reason: "cannot resolve API key for configured compaction model" };
      return { ok: true, model, apiKey: auth.apiKey ?? "", headers: auth.headers };
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok) return { ok: false, reason: "cannot resolve API key for session model" };
    return { ok: true, model: ctx.model, apiKey: auth.apiKey ?? "", headers: auth.headers };
  }

  async launchObserverTask<T>(
    ctx: { hasUI: boolean; ui?: { notify: (msg: string, level?: "info" | "warning" | "error") => void } },
    taskName: string,
    fn: () => Promise<T>,
  ): Promise<void> {
    this.observerInFlight = true;
    this.observerPromise = (async () => {
      try {
        await fn();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI && ctx.ui) ctx.ui.notify(`Observer "${taskName}" failed: ${msg}`, "warning");
      } finally {
        this.observerInFlight = false;
        this.observerPromise = null;
      }
    })();
    await this.observerPromise;
  }
}
