// Runtime: holds config, in-flight state, and model resolution
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ResolveResult, UnifiedConfig } from "./types.js";
import { DEFAULT_EXTENSION_CONFIG, DEFAULT_HYBRID_SETTINGS, loadConfig } from "./config.js";
import { CacheTelemetry } from "./cache-telemetry.js";
import { ObserverEpochManager } from "./om/observer-epoch.js";
import { ObserverTaskCoordinator } from "./observer-task.js";

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
  readonly observerEpoch = new ObserverEpochManager();
  readonly observerTask = new ObserverTaskCoordinator();
  piSessionId: string | null = null;

  // In-flight state
  compactHookInFlight = false;
  autoCompactionInFlight = false;
  resolveFailureNotified = false;
  observerEmptyBackoff: { boundaryId: string; tokensAtEmpty: number } | null = null;

  // One-shot notice: set when we've surfaced the "old compaction boundary
  // unresolved" recovery notice. Only the first firing after a (re)load should
  // notify the user; subsequent fires within the same session stay silent.
  // Reset explicitly only by re-instantiation (process restart).
  boundaryRecoveryNotified = false;

  constructor() {
    this.config = {
      extension: { ...DEFAULT_EXTENSION_CONFIG },
      hybrid: { ...DEFAULT_HYBRID_SETTINGS },
    };
  }

  ensureConfig(
    cwd: string,
    projectTrusted: boolean,
    notify?: (msg: string, level?: "info" | "warning" | "error") => void,
  ): void {
    if (!this.loadedConfig) {
      this.config = loadConfig(cwd, projectTrusted, notify);
      this.loadedConfig = true;
    }
  }

  setPiSessionId(sessionId: string | undefined): void {
    const next = sessionId?.trim() || null;
    if (this.piSessionId !== next) this.observerEpoch.invalidate("session-change");
    this.piSessionId = next;
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
    model: Model<Api>;
    modelRegistry: {
      find: (provider: string, id: string) => Model<Api> | undefined;
      getApiKeyAndHeaders: (model: Model<Api>) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string> }>;
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
}
