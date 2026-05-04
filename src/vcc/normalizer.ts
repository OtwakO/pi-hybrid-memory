// Normalizer: converts raw Pi messages to NormalizedBlocks — ported from pi-vcc
import type { Message } from "@mariozechner/pi-ai";
import type { NormalizedBlock } from "../types.js";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { text: string } => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

function sanitize(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\u2028/g, "\n")
    .replace(/\u2029/g, "\n");
}

const normalizeOne = (msg: Message, msgIndex: number): NormalizedBlock[] => {
  if (msg.role === "user") {
    const blocks: NormalizedBlock[] = [];
    const text = sanitize(textOf(msg.content));
    if (text) blocks.push({ kind: "user", text, sourceIndex: msgIndex });
    if (msg.content && typeof msg.content !== "string") {
      for (const part of msg.content) {
        if (part.type === "image") {
          blocks.push({ kind: "user", text: `[image: ${part.mimeType}]`, sourceIndex: msgIndex });
        }
      }
    }
    return blocks.length > 0 ? blocks : [{ kind: "user", text: "", sourceIndex: msgIndex }];
  }

  if (msg.role === "toolResult") {
    return [{
      kind: "tool_result",
      name: msg.toolName ?? "unknown",
      text: sanitize(textOf(msg.content)),
      isError: msg.isError ?? false,
      sourceIndex: msgIndex,
    }];
  }

  if (msg.role === "assistant") {
    if (!msg.content) return [];
    if (typeof msg.content === "string") {
      return [{ kind: "assistant", text: sanitize(msg.content), sourceIndex: msgIndex }];
    }

    const blocks: NormalizedBlock[] = [];
    for (const part of msg.content) {
      if (part.type === "text") {
        blocks.push({ kind: "assistant", text: sanitize(part.text ?? ""), sourceIndex: msgIndex });
      } else if (part.type === "thinking") {
        blocks.push({
          kind: "thinking",
          text: sanitize(part.thinking ?? ""),
          redacted: part.redacted ?? false,
          sourceIndex: msgIndex,
        });
      } else if (part.type === "toolCall") {
        blocks.push({
          kind: "tool_call",
          name: part.name ?? "",
          args: part.arguments ?? {},
          sourceIndex: msgIndex,
        });
      }
    }
    return blocks;
  }

  return [];
};

export const normalize = (messages: Message[]): NormalizedBlock[] =>
  messages.flatMap((msg, i) => normalizeOne(msg, i));
