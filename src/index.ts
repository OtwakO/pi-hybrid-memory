// pi-hybrid-memory: merges semantic observational memory with structural VCC compaction into a single unified summary
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Runtime } from "./runtime.js";
import { registerCompactionHook } from "./compaction-hook.js";
import { registerObserverTrigger } from "./observer-trigger.js";
import { registerAutoCompactionTrigger } from "./auto-compaction.js";
import { registerStatusCommand } from "./status.js";
import { registerMemoryCommand } from "./memory.js";
import { registerRecallTool } from "./tools/recall.js";
import { registerCacheInfoCommand } from "./cache-telemetry.js";

export default function extension(pi: ExtensionAPI): void {
  const runtime = new Runtime();
  // Config loaded lazily on first hook invocation — see observer-trigger, compaction-hook, status

  // Register the unified compaction hook
  registerCompactionHook(pi, runtime);

  // Register proactive observer and post-agent compaction triggers
  registerObserverTrigger(pi, runtime);
  registerAutoCompactionTrigger(pi, runtime);

  // Register status and cache telemetry commands
  registerStatusCommand(pi, runtime);
  registerCacheInfoCommand(pi, runtime.cacheTelemetry, runtime.observerEpoch);

  pi.on("session_start", (_event, ctx) => {
    runtime.setPiSessionId(ctx.sessionManager.getSessionId());
  });
  const leaveObserverEpoch = (
    cancellation: "session-switch" | "session-fork" | "tree-navigation" | "session-shutdown",
  ) => {
    runtime.observerTask.cancel(cancellation);
    runtime.reflectionTask.cancel(cancellation);
    runtime.observerEpoch.invalidate("session-change");
  };
  pi.on("session_before_switch", () => leaveObserverEpoch("session-switch"));
  pi.on("session_before_fork", () => leaveObserverEpoch("session-fork"));
  pi.on("session_before_tree", () => leaveObserverEpoch("tree-navigation"));
  pi.on("session_shutdown", () => leaveObserverEpoch("session-shutdown"));

  // Register the /hm-memory command
  registerMemoryCommand(pi, runtime);

  // Register the hm_recall tool
  registerRecallTool(pi);
}
