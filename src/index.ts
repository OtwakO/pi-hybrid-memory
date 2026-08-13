// pi-hybrid-memory: merges semantic observational memory with structural VCC compaction into a single unified summary
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Runtime } from "./runtime.js";
import { registerCompactionHook } from "./compaction-hook.js";
import { registerObserverTrigger } from "./observer-trigger.js";
import { registerAutoCompactionTrigger } from "./auto-compaction.js";
import { registerStatusCommand } from "./status.js";
import { registerMemoryCommand } from "./memory.js";
import { registerRecallTool } from "./tools/recall.js";
import { registerCacheInfoCommand } from "./cache-telemetry.js";

const runtime = new Runtime();

export default function extension(pi: ExtensionAPI): void {
  // Config loaded lazily on first hook invocation — see observer-trigger, compaction-hook, status

  // Register the unified compaction hook
  registerCompactionHook(pi, runtime);

  // Register proactive observer and post-agent compaction triggers
  registerObserverTrigger(pi, runtime);
  registerAutoCompactionTrigger(pi, runtime);

  // Register status and cache telemetry commands
  registerStatusCommand(pi, runtime);
  registerCacheInfoCommand(pi, runtime.cacheTelemetry);

  pi.on("session_start", (_event, ctx) => {
    runtime.setPiSessionId(ctx.sessionManager.getSessionId());
  });

  // Register the /hm-memory command
  registerMemoryCommand(pi);

  // Register the hm_recall tool
  registerRecallTool(pi);
}
