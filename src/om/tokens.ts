// Token utilities — ported from pi-observational-memory
const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { text?: string } => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n");
  }
  return "";
};

const entryBody = (entry: unknown): string => {
  const e = entry as Record<string, unknown>;
  if (e.type === "message" && e.message && typeof e.message === "object") {
    const msg = e.message as Record<string, unknown>;
    if (msg.role === "user" || msg.role === "toolResult") return textOf(msg.content);
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        const blocks = msg.content as Array<Record<string, unknown>>;
        const thinking = blocks
          .filter((b) => b.type === "thinking" && typeof b.thinking === "string")
          .map((b) => b.thinking as string)
          .join("\n");
        const text = blocks
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("\n");
        return thinking ? `${thinking}\n${text}` : text;
      }
      return "";
    }
  }
  if (e.type === "custom" && typeof e.content === "string") return e.content;
  if (e.type === "custom_message" && typeof e.content === "string") return e.content;
  if (e.type === "branch_summary" && typeof e.summary === "string") return e.summary;
  return "";
};

export const estimateEntryTokens = (entry: unknown): number => {
  const text = entryBody(entry);
  if (!text) return 5;
  const words = text.split(/\s+/).length;
  return Math.max(1, Math.ceil(words * 1.3));
};

export const estimateStringTokens = (text: string): number => {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.split(/\s+/).length * 1.3));
};
