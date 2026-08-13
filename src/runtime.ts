// Runtime: holds config, in-flight state, and model resolution
import type { ResolveResult, UnifiedConfig } from "./types.js";
import { loadConfig } from "./config.js";
import { CacheTelemetry } from "./cache-telemetry.js";

const hasUsableAuth = (auth: {
  ok: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
}): boolean => {
  if (!auth.ok) return false;
  if (auth.apiKey?.trim()) return true;
  return Object.values(auth.headers ?? {}).some(value => value.trim().length > 0);
};

export class Runtime {
  config: UnifiedConfig;
  loadedConfig = false;
  readonly cacheTelemetry = new CacheTelemetry();

  // In-flight state
  observerInFlight = false;
  compactHookInFlight = false;
  autoCompactionInFlight = false;
  resolveFailureNotified = false;
  observerPromise: Promise<void> | null = null;
  observerEmptyBackoff: { boundaryId: string; tokensAtEmpty: number } | null = null;

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
        observerChunkMaxTokens: 60000,
        compactionThresholdTokens: 50000,
        compactionThresholdPercentage: 80,
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

  shouldBackOffEmptyObserver(boundaryId: string, currentTokens: number, threshold: number): boolean {
    const backoff = this.observerEmptyBackoff;
    if (!backoff || backoff.boundaryId !== boundaryId) {
      this.observerEmptyBackoff = null;
      return false;
    }
    return currentTokens < backoff.tokensAtEmpty + threshold;
  }

  recordEmptyObserverResult(boundaryId: string, currentTokens: number): void {
    this.observerEmptyBackoff = { boundaryId, tokensAtEmpty: currentTokens };
  }

  clearEmptyObserverBackoff(): void {
    this.observerEmptyBackoff = null;
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
      if (!hasUsableAuth(auth)) {
        return { ok: false, reason: "configured compaction model has no usable API key or auth header" };
      }
      return { ok: true, model, apiKey: auth.apiKey ?? "", headers: auth.headers };
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!hasUsableAuth(auth)) {
      return { ok: false, reason: "session model has no usable API key or auth header" };
    }
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
