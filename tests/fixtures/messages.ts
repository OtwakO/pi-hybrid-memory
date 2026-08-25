import type { AssistantMessage } from "@earendil-works/pi-ai";

export const assistantMessage = (
  content: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: content }],
  api: "openai-completions",
  provider: "test",
  model: "model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: 1,
});
