// Runtime: holds config, in-flight state, and model resolution
import { resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ResolveResult, UnifiedConfig } from "./types.js";
import { DEFAULT_EXTENSION_CONFIG, DEFAULT_HYBRID_SETTINGS, loadConfig } from "./config.js";
import { CacheTelemetry } from "./cache-telemetry.js";
import { ObserverEpochManager } from "./om/observer-epoch.js";
import { ObserverTaskCoordinator } from "./observer-task.js";

type ConfigLoader = typeof loadConfig;

interface ConfigContext {
  cwd: string;
  isProjectTrusted(): boolean;
  hasUI: boolean;
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
}

export class Runtime {
  config: UnifiedConfig;
  private configScopeKey: string | null = null;
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

  constructor(private readonly configLoader: ConfigLoader = loadConfig) {
    this.config = {
      extension: { ...DEFAULT_EXTENSION_CONFIG },
      hybrid: { ...DEFAULT_HYBRID_SETTINGS },
    };
  }

  ensureConfig(ctx: ConfigContext): void {
    const canonicalCwd = resolve(ctx.cwd);
    const projectTrusted = ctx.isProjectTrusted();
    const scopeKey = `${canonicalCwd}\u0000${projectTrusted ? "trusted" : "untrusted"}`;
    if (this.configScopeKey === scopeKey) return;
    const notify = ctx.hasUI
      ? (message: string, level?: "info" | "warning" | "error") => ctx.ui.notify(message, level)
      : undefined;
    this.config = this.configLoader(canonicalCwd, projectTrusted, notify);
    this.configScopeKey = scopeKey;
  }

  setPiSessionId(sessionId: string | undefined): void {
    const next = sessionId?.trim() || null;
    if (this.piSessionId !== next) {
      this.observerEpoch.invalidate("session-change");
      this.observerEmptyBackoff = null;
      this.boundaryRecoveryNotified = false;
    }
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

  resolveModel(ctx: {
    model?: Model<Api>;
    modelRegistry: {
      find: (provider: string, id: string) => Model<Api> | undefined;
    };
  }): ResolveResult {
    const overrideModel = this.config.hybrid.compactionModel;
    if (overrideModel) {
      const model = ctx.modelRegistry.find(overrideModel.provider, overrideModel.id);
      if (!model) {
        return { ok: false, reason: `configured compaction model ${overrideModel.provider}/${overrideModel.id} not found` };
      }
      return { ok: true, model };
    }

    if (!ctx.model) return { ok: false, reason: "session has no active model" };
    return { ok: true, model: ctx.model };
  }
}
