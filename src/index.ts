// pi-hybrid-memory: merges semantic observational memory with structural VCC compaction into a single unified summary
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Runtime } from "./runtime.js";
import { registerCompactionHook } from "./compaction-hook.js";
import { registerObserverTrigger } from "./observer-trigger.js";
import { registerStatusCommand } from "./status.js";
import { registerRecallTool } from "./tools/recall.js";

const runtime = new Runtime();

export default function extension(pi: ExtensionAPI): void {
  runtime.ensureConfig(process.cwd(), (msg, level) => {
    pi.on("session_start", () => {}); // trigger config load notification via UI later
  });

  // Register the unified compaction hook
  registerCompactionHook(pi, runtime);

  // Register the proactive observer trigger
  registerObserverTrigger(pi, runtime);

  // Register the /hm-status command
  registerStatusCommand(pi, runtime);

  // Register the hm-recall tool
  registerRecallTool(pi);
}
