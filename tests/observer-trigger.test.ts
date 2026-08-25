import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { assistantMessage } from "./fixtures/messages.js";

import { registerObserverTrigger } from "../src/observer-trigger.js";
import { Runtime } from "../src/runtime.js";
import { OBSERVATION_CUSTOM_TYPE, type Entry, type ObservationEntryData } from "../src/types.js";

const runObserverMock = vi.hoisted(() => vi.fn());

vi.mock("../src/om/observer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/om/observer.js")>();
  return { ...actual, runObserver: runObserverMock };
});

const source = (id: string, content: string): Entry => ({
  type: "message",
  id,
  timestamp: "2026-08-26T00:00:00Z",
  message: { role: "user", content, timestamp: 1 },
});

const boundary = (id: string, coversUpToId: string): Entry => ({
  type: "custom",
  id,
  customType: OBSERVATION_CUSTOM_TYPE,
  data: {
    records: [],
    coversFromId: coversUpToId,
    coversUpToId,
    tokenCount: 0,
  } satisfies ObservationEntryData,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
};

const setup = () => {
  let sessionId = "session-a";
  let entries: Entry[] = [
    source("raw-0", "already covered"),
    boundary("obs-0", "raw-0"),
    source("raw-1", "new durable fact ".repeat(30)),
  ];
  let turnHandler: ((event: unknown, ctx: typeof ctx) => void) | undefined;
  const appendEntry = vi.fn((customType: string, data: ObservationEntryData) => {
    entries = [...entries, {
      type: "custom",
      id: `obs-${entries.length}`,
      customType,
      data,
    }];
  });
  const pi = {
    on: vi.fn((event: string, handler: typeof turnHandler) => {
      if (event === "turn_end") turnHandler = handler;
    }),
    appendEntry,
  };
  const ctx = {
    cwd: "/project",
    isProjectTrusted: () => true,
    hasUI: false,
    signal: undefined as AbortSignal | undefined,
    model: { provider: "test", api: "openai-completions", id: "model", contextWindow: 100_000 },
    modelRegistry: {
      find: vi.fn(),
      complete: vi.fn(),
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => entries.at(-1)?.id,
      getBranch: () => entries,
    },
  };
  const runtime = new Runtime();
  runtime.loadedConfig = true;
  runtime.config.hybrid.observationThresholdTokens = 1;
  runtime.setPiSessionId(sessionId);
  registerObserverTrigger(pi as never, runtime);

  return {
    appendEntry,
    ctx,
    runtime,
    trigger: async () => { await turnHandler?.({}, ctx); },
    appendSource: (id: string) => { entries = [...entries, source(id, "later descendant")]; },
    navigate: () => { entries = [source("other-root", "different branch")]; },
    replaceSession: () => { sessionId = "session-b"; },
  };
};

const successfulResult = (sourceDeltaPrompt: Message) => ({
  ok: true as const,
  records: [{
    id: "observation1",
    content: "new durable fact",
    timestamp: "2026-08-26T00:00:01Z",
    relevance: "high" as const,
    sourceEntryIds: ["raw-1"],
  }],
  transcriptSuffix: [sourceDeltaPrompt, assistantMessage("recorded")],
});

const pendingObserver = () => {
  const pending = deferred<ReturnType<typeof successfulResult>>();
  runObserverMock.mockImplementation(async () => pending.promise);
  const resolve = () => {
    const options = runObserverMock.mock.calls[0][0] as { prompts: Message[] };
    pending.resolve(successfulResult(options.prompts[0]));
  };
  return { resolve };
};

describe("proactive observer lifecycle transaction", () => {
  beforeEach(() => runObserverMock.mockReset());

  it("passes the composed turn signal and persists after same-branch growth", async () => {
    const pending = pendingObserver();
    const fixture = setup();
    const turn = new AbortController();
    fixture.ctx.signal = turn.signal;

    await fixture.trigger();
    const task = fixture.runtime.observerTask.promise;
    fixture.appendSource("raw-2");
    pending.resolve();
    const outcome = await task;

    if (outcome?.status === "failed") throw outcome.error;
    expect(outcome).toEqual({ status: "completed" });
    expect(runObserverMock).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(runObserverMock.mock.calls[0][0].signal).not.toBe(turn.signal);
    expect(fixture.appendEntry).toHaveBeenCalledOnce();
    expect(fixture.runtime.observerEpoch.stats().coverageEndId).toBe("raw-1");
  });

  it("does not persist or commit the epoch after the active turn aborts", async () => {
    const pending = pendingObserver();
    const fixture = setup();
    const turn = new AbortController();
    fixture.ctx.signal = turn.signal;

    await fixture.trigger();
    const task = fixture.runtime.observerTask.promise;
    turn.abort();
    pending.resolve();
    const outcome = await task;

    expect(outcome).toMatchObject({ status: "cancelled", reason: "turn-aborted" });
    expect(fixture.appendEntry).not.toHaveBeenCalled();
    expect(fixture.runtime.observerEpoch.stats().active).toBe(false);
  });

  it("does not persist or commit the epoch after branch navigation", async () => {
    const pending = pendingObserver();
    const fixture = setup();

    await fixture.trigger();
    const task = fixture.runtime.observerTask.promise;
    fixture.navigate();
    pending.resolve();
    await task;

    expect(fixture.appendEntry).not.toHaveBeenCalled();
    expect(fixture.runtime.observerEpoch.stats().active).toBe(false);
  });

  it("does not persist or commit the epoch after session replacement", async () => {
    const pending = pendingObserver();
    const fixture = setup();

    await fixture.trigger();
    const task = fixture.runtime.observerTask.promise;
    fixture.replaceSession();
    pending.resolve();
    await task;

    expect(fixture.appendEntry).not.toHaveBeenCalled();
    expect(fixture.runtime.observerEpoch.stats().active).toBe(false);
  });

  it("does not commit epoch state when durable persistence throws", async () => {
    const pending = pendingObserver();
    const fixture = setup();
    fixture.appendEntry.mockImplementationOnce(() => { throw new Error("disk write failed"); });

    await fixture.trigger();
    const task = fixture.runtime.observerTask.promise;
    pending.resolve();
    const outcome = await task;

    expect(outcome).toMatchObject({ status: "failed" });
    expect(fixture.runtime.observerEpoch.stats().active).toBe(false);
  });
});
