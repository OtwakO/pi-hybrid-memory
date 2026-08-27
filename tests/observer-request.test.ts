import { describe, expect, it } from "vitest";

import { ObserverEpochManager } from "../src/om/observer-epoch.js";
import { prepareObserverSourceRequest } from "../src/om/observer-request.js";
import type { Entry } from "../src/types.js";

const source = (id: string, content: string): Entry => ({
  type: "message",
  id,
  timestamp: "2026-08-27T00:00:00Z",
  message: { role: "user", content, timestamp: 1 },
});

const baseInput = {
  epoch: new ObserverEpochManager(),
  compatibilityKey: "test|observer-request-v1",
  expectedCoverageId: "raw-0",
  baselineText: "stable memory baseline",
  fixedTokens: 20,
  minimumSourceTokens: 16,
};

describe("observer source request preparation", () => {
  it.each([
    {
      name: "shrinks a near-boundary source",
      input: {
        entries: [source("raw-1", "durable source fact ".repeat(80))],
        maxTokens: 240,
        sourceMaxTokens: 240,
      },
      expected: "partial",
    },
    {
      name: "keeps an exact final-request fit complete",
      input: {
        entries: [source("raw-1", "short durable fact")],
        maxTokens: 193,
        sourceMaxTokens: 1_000,
      },
      expected: "complete",
    },
    {
      name: "keeps a complete short source below the preferred segment minimum",
      input: {
        entries: [source("raw-1", "short durable fact")],
        maxTokens: 193,
        sourceMaxTokens: 1_000,
        minimumSourceTokens: 256,
      },
      expected: "complete",
    },
    {
      name: "fails when only a partial segment remains below the useful minimum",
      input: {
        entries: [source("raw-1", "durable source fact ".repeat(80))],
        maxTokens: 190,
        sourceMaxTokens: 1_000,
      },
      expected: "pressure",
    },
  ])("$name", ({ input, expected }) => {
    const result = prepareObserverSourceRequest({ ...baseInput, ...input });

    if (expected === "pressure") {
      expect(result).toMatchObject({
        ok: false,
        reason: "insufficient-source-capacity",
        capacity: {
          minimumDeltaTokens: 16,
          pressured: true,
        },
      });
      return;
    }

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.projectedTokens).toBeLessThanOrEqual(input.maxTokens);
    if (expected === "partial") {
      expect(result.serialized.sourceProgress).toMatchObject({ sourceEntryId: "raw-1" });
      expect(result.serialized.hasMore).toBe(true);
    } else {
      expect(result.prepared.projectedTokens).toBe(input.maxTokens);
      expect(result.serialized.sourceProgress).toBeUndefined();
      expect(result.serialized.hasMore).toBe(false);
    }
  });
});
