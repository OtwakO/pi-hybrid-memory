import { describe, expect, it } from "vitest";
import type { Message } from "@mariozechner/pi-ai";

import { ObserverEpochManager } from "../src/om/observer-epoch.js";

const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
const assistant = (content: string): Message => ({
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
  stopReason: "stop",
  timestamp: 1,
});

const baseInput = {
  compatibilityKey: "model|prompt-v1|tool-v1|serializer-v1",
  expectedCoverageId: "raw-0",
  baselineText: "stable baseline memory",
  deltaText: "source delta one",
  maxTokens: 1_000,
  fixedTokens: 20,
};

describe("ObserverEpochManager", () => {
  it("makes each committed request an exact message prefix of the next request", () => {
    const manager = new ObserverEpochManager();
    const first = manager.prepare(baseInput);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const firstSuffix = [...first.prompts, assistant("recorded delta one")];
    const firstRequest = [...first.contextMessages, ...firstSuffix];
    manager.commit(first, firstSuffix, "raw-1");

    const second = manager.prepare({
      ...baseInput,
      expectedCoverageId: "raw-1",
      deltaText: "source delta two",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.cold).toBe(false);
    expect(second.contextMessages).toEqual(firstRequest);
    expect([...second.contextMessages, ...second.prompts].slice(0, firstRequest.length)).toEqual(firstRequest);
  });

  it("rejects stale transactions prepared before a newer run", () => {
    const manager = new ObserverEpochManager();
    const stale = manager.prepare(baseInput);
    const current = manager.prepare({ ...baseInput, deltaText: "current" });
    expect(stale.ok).toBe(true);
    expect(current.ok).toBe(true);
    if (!stale.ok || !current.ok) return;

    expect(() => manager.commit(stale, [...stale.prompts, assistant("stale")], "raw-1")).toThrow("stale");
    manager.commit(current, [...current.prompts, assistant("current")], "raw-1");
    expect(manager.stats().coverageEndId).toBe("raw-1");
  });

  it("does not mutate committed state when a prepared run is abandoned", () => {
    const manager = new ObserverEpochManager();
    const first = manager.prepare(baseInput);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const committedSuffix = [...first.prompts, assistant("committed")];
    const committedRequest = [...first.contextMessages, ...committedSuffix];
    manager.commit(first, committedSuffix, "raw-1");

    const abandoned = manager.prepare({ ...baseInput, expectedCoverageId: "raw-1", deltaText: "abandoned" });
    expect(abandoned.ok).toBe(true);

    const retry = manager.prepare({ ...baseInput, expectedCoverageId: "raw-1", deltaText: "retry" });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.contextMessages).toEqual(committedRequest);
    expect(retry.prompts.at(-1)).toMatchObject({ content: expect.stringContaining("retry") });
  });

  it("resets on coverage discontinuity or compatibility change", () => {
    const manager = new ObserverEpochManager();
    const first = manager.prepare(baseInput);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    manager.commit(first, [...first.prompts, assistant("committed")], "raw-1");

    const discontinuous = manager.prepare({ ...baseInput, expectedCoverageId: "other", deltaText: "next" });
    expect(discontinuous.ok).toBe(true);
    if (!discontinuous.ok) return;
    expect(discontinuous.cold).toBe(true);
    expect(discontinuous.resetReason).toBe("coverage-discontinuity");

    manager.commit(discontinuous, [...discontinuous.prompts, assistant("new epoch")], "raw-2");
    const incompatible = manager.prepare({
      ...baseInput,
      compatibilityKey: "different-model|prompt-v1|tool-v1|serializer-v1",
      expectedCoverageId: "raw-2",
    });
    expect(incompatible.ok).toBe(true);
    if (!incompatible.ok) return;
    expect(incompatible.cold).toBe(true);
    expect(incompatible.resetReason).toBe("compatibility-change");
  });

  it("classifies fresh baseline pressure before attempting a source request", () => {
    const manager = new ObserverEpochManager();

    const capacity = manager.freshEpochCapacity({
      baselineText: "baseline ".repeat(200),
      deltaOverheadText: "instructions",
      maxTokens: 300,
      fixedTokens: 100,
      minimumDeltaTokens: 256,
    });

    expect(capacity.availableDeltaTokens).toBe(0);
    expect(capacity.occupiedTokens).toBeGreaterThan(300);
    expect(capacity.pressured).toBe(true);
  });

  it("computes the source-delta budget remaining after baseline and safety reservations", () => {
    const manager = new ObserverEpochManager();
    const small = manager.freshDeltaTokenBudget({
      baselineText: "short baseline",
      deltaOverheadText: "instructions",
      maxTokens: 1_000,
      fixedTokens: 100,
    });
    const large = manager.freshDeltaTokenBudget({
      baselineText: "baseline ".repeat(200),
      deltaOverheadText: "instructions",
      maxTokens: 1_000,
      fixedTokens: 100,
    });

    expect(small).toBeGreaterThan(large);
    expect(large).toBeGreaterThanOrEqual(0);
  });

  it("validates a transaction before persistence and commits without a second throwing check", () => {
    const manager = new ObserverEpochManager();
    const prepared = manager.prepare(baseInput);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const suffix = [...prepared.prompts, assistant("committed")];

    manager.validateCommit(prepared, suffix);
    expect(() => manager.commitValidated(prepared, suffix, "raw-1")).not.toThrow();
    expect(manager.stats().coverageEndId).toBe("raw-1");
  });

  it("rolls over before capacity and fails only when a fresh baseline cannot fit", () => {
    const manager = new ObserverEpochManager();
    const first = manager.prepare(baseInput);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    manager.commit(first, [...first.prompts, assistant("large committed history ".repeat(80))], "raw-1");

    const rollover = manager.prepare({
      ...baseInput,
      expectedCoverageId: "raw-1",
      deltaText: "small next delta",
      maxTokens: 80,
    });
    expect(rollover.ok).toBe(true);
    if (!rollover.ok) return;
    expect(rollover.cold).toBe(true);
    expect(rollover.resetReason).toBe("capacity");

    const impossible = new ObserverEpochManager().prepare({
      ...baseInput,
      baselineText: "baseline ".repeat(100),
      deltaText: "delta ".repeat(100),
      maxTokens: 20,
    });
    expect(impossible).toMatchObject({ ok: false, reason: "fresh-baseline-overflow" });
  });

  it("reports an explicit invalidation reason on the next cold epoch", () => {
    const manager = new ObserverEpochManager();
    manager.invalidate("compaction");

    const prepared = manager.prepare(baseInput);

    expect(prepared.ok).toBe(true);
    if (prepared.ok) expect(prepared.resetReason).toBe("compaction");
  });

  it("forks without letting a draft mutate the live epoch", () => {
    const manager = new ObserverEpochManager();
    const first = manager.prepare(baseInput);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    manager.commit(first, [...first.prompts, assistant("live")], "raw-1");

    const draft = manager.fork();
    const draftRun = draft.prepare({ ...baseInput, expectedCoverageId: "raw-1", deltaText: "draft" });
    expect(draftRun.ok).toBe(true);
    if (!draftRun.ok) return;
    draft.commit(draftRun, [...draftRun.prompts, assistant("draft committed")], "raw-2");

    expect(manager.stats().coverageEndId).toBe("raw-1");
    expect(draft.stats().coverageEndId).toBe("raw-2");
  });
});
