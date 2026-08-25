import { describe, expect, it, vi } from "vitest";

import { ObserverTaskCoordinator } from "../src/observer-task.js";
import type { Entry } from "../src/types.js";

const entry = (id: string): Entry => ({ type: "message", id });

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
};

const session = () => {
  let sessionId = "session-a";
  let branch = [entry("root"), entry("origin")];
  return {
    identity: {
      getSessionId: () => sessionId,
      getLeafId: () => branch.at(-1)?.id,
      getBranch: () => branch,
    },
    replaceSession: () => { sessionId = "session-b"; },
    append: (id: string) => { branch = [...branch, entry(id)]; },
    navigate: () => { branch = [entry("root"), entry("other")]; },
  };
};

describe("ObserverTaskCoordinator", () => {
  it("allows a synchronous commit after same-branch descendant appends", async () => {
    const current = session();
    const coordinator = new ObserverTaskCoordinator();
    const persist = vi.fn();

    const result = await coordinator.start({
      session: current.identity,
      run: async ({ commitSync }) => {
        current.append("later-turn");
        commitSync(persist);
      },
    });

    expect(result).toEqual({ status: "completed" });
    expect(persist).toHaveBeenCalledOnce();
    expect(coordinator.active).toBe(false);
    expect(coordinator.promise).toBeNull();
  });

  it("rejects persistence after navigation leaves the originating branch path", async () => {
    const current = session();
    const coordinator = new ObserverTaskCoordinator();
    const persist = vi.fn();

    const result = await coordinator.start({
      session: current.identity,
      run: async ({ commitSync }) => {
        current.navigate();
        commitSync(persist);
      },
    });

    expect(result).toMatchObject({ status: "cancelled", reason: "branch-changed" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects persistence after session replacement", async () => {
    const current = session();
    const coordinator = new ObserverTaskCoordinator();
    const persist = vi.fn();

    const result = await coordinator.start({
      session: current.identity,
      run: async ({ commitSync }) => {
        current.replaceSession();
        commitSync(persist);
      },
    });

    expect(result).toMatchObject({ status: "cancelled", reason: "session-changed" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("composes the active turn signal and blocks work after it aborts", async () => {
    const current = session();
    const parent = new AbortController();
    const coordinator = new ObserverTaskCoordinator();
    let receivedSignal: AbortSignal | undefined;

    const result = await coordinator.start({
      session: current.identity,
      signal: parent.signal,
      run: async ({ signal, throwIfCancelled }) => {
        receivedSignal = signal;
        parent.abort("turn-aborted");
        throwIfCancelled();
      },
    });

    expect(receivedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({ status: "cancelled", reason: "turn-aborted" });
  });

  it("skips a racing second task instead of throwing", async () => {
    const current = session();
    const coordinator = new ObserverTaskCoordinator();
    const gate = deferred<void>();
    const first = coordinator.start({
      session: current.identity,
      run: async () => { await gate.promise; },
    });

    await expect(coordinator.start({
      session: current.identity,
      run: async () => { throw new Error("must not run"); },
    })).resolves.toEqual({ status: "skipped", reason: "already-active" });

    gate.resolve();
    await first;
  });

  it("cancels active session work idempotently", async () => {
    const current = session();
    const coordinator = new ObserverTaskCoordinator();
    let release!: () => void;
    const started = new Promise<void>(resolve => { release = resolve; });

    const task = coordinator.start({
      session: current.identity,
      run: async ({ signal, throwIfCancelled }) => {
        await started;
        expect(signal.aborted).toBe(true);
        throwIfCancelled();
      },
    });

    coordinator.cancel("session-shutdown");
    coordinator.cancel("session-shutdown");
    release();

    await expect(task).resolves.toMatchObject({
      status: "cancelled",
      reason: "session-shutdown",
    });
  });

  it("reports ordinary task failures without classifying them as cancellation", async () => {
    const current = session();
    const coordinator = new ObserverTaskCoordinator();
    const error = new Error("provider failed");

    const result = await coordinator.start({
      session: current.identity,
      run: async () => { throw error; },
    });

    expect(result).toEqual({ status: "failed", error });
  });
});
