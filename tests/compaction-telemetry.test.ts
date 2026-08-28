import { describe, expect, it } from "vitest";
import { CacheTelemetry } from "../src/cache-telemetry.js";
import { foldMemory } from "../src/om/memory-fold.js";
import type { ReflectionModelPort } from "../src/om/reflection-model.js";

const model = {
  provider: "test-provider",
  id: "test-model",
  contextWindow: 32_000,
  maxTokens: 8_000,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
};

const observation = {
  id: "aaaaaaaaaaaa",
  content: "durable fact",
  timestamp: "2026-01-01 00:00",
  relevance: "high" as const,
  sourceEntryIds: ["1234abcd"],
};

const fold = (
  telemetry: CacheTelemetry,
  modelPort: ReflectionModelPort,
) => foldMemory({
  params: { model, telemetry },
  reflections: [],
  observations: [observation],
  focusObservations: [observation],
  canonicalObservationIds: new Set([observation.id]),
  contextBudgets: {
    reflectionTokens: 256,
    focusObservationTokens: 1_000,
    protectedObservationTokens: 1_000,
    recentObservationTokens: 320,
  },
  reflectionThresholdTokens: 0,
  targetSummaryTokens: 16_000,
  modelPort,
});

describe("memory-fold lifecycle telemetry", () => {
  it("records accepted reflection counts", async () => {
    const telemetry = new CacheTelemetry();
    const result = await fold(telemetry, {
      propose: async () => ({
        ok: true,
        proposal: {
          reflections: [{
            content: "durable reflection",
            supportingEvidenceHandles: ["E001"],
          }],
        },
      }),
    });

    expect(result).toMatchObject({ ok: true, outcome: "reflected" });
    expect(telemetry.memoryLifecycleAggregate("reflector")).toMatchObject({
      attempts: 1,
      outcomes: { success: 1 },
      inputItems: 1,
      proposedItems: 1,
      acceptedItems: 1,
      rejectedItems: 0,
    });
  });

  it("distinguishes deliberate empty, no-change, missing tool call, and invalid provenance", async () => {
    const telemetry = new CacheTelemetry();

    await fold(telemetry, { propose: async () => ({ ok: true, proposal: { reflections: [] } }) });
    await foldMemory({
      params: { model, telemetry },
      reflections: [{
        id: "bbbbbbbbbbbb",
        content: "durable reflection",
        supportingObservationIds: [observation.id],
      }],
      observations: [observation],
      focusObservations: [observation],
      canonicalObservationIds: new Set([observation.id]),
      contextBudgets: {
        reflectionTokens: 256,
        focusObservationTokens: 1_000,
        protectedObservationTokens: 1_000,
        recentObservationTokens: 320,
      },
      reflectionThresholdTokens: 0,
      targetSummaryTokens: 16_000,
      modelPort: {
        propose: async () => ({
          ok: true,
          proposal: { reflections: [{
            content: "durable reflection",
            supportingEvidenceHandles: ["E001"],
          }] },
        }),
      },
    });
    await fold(telemetry, { propose: async () => ({ ok: false, reason: "missing-tool-call" }) });
    await fold(telemetry, {
      propose: async () => ({
        ok: true,
        proposal: {
          reflections: [{
            content: "unsupported",
            supportingEvidenceHandles: ["E999"],
          }],
        },
      }),
    });

    expect(telemetry.memoryLifecycleAggregate("reflector")).toMatchObject({
      attempts: 4,
      outcomes: {
        "deliberate-empty": 1,
        "no-change": 1,
        "missing-tool-call": 1,
        "invalid-provenance": 1,
      },
      inputItems: 4,
      proposedItems: 2,
      acceptedItems: 0,
      rejectedItems: 1,
    });
  });
});
