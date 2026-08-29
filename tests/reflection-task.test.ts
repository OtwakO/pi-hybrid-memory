import { describe, expect, it } from "vitest";

import { ReflectionTaskCoordinator } from "../src/reflection-task.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
};

describe("ReflectionTaskCoordinator", () => {
  it("runs one task at a time and coalesces progress into one latest rerun", async () => {
    const coordinator = new ReflectionTaskCoordinator();
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    const runs: string[] = [];
    const first = coordinator.start(async () => {
      runs.push("first");
      await releaseFirst.promise;
    });
    void coordinator.start(async () => {
      runs.push("obsolete");
    });
    void coordinator.start(async () => {
      runs.push("latest");
      await releaseSecond.promise;
    });

    expect(coordinator.active).toBe(true);
    expect(runs).toEqual(["first"]);
    releaseFirst.resolve();
    expect(await first).toEqual({ status: "completed" });
    await Promise.resolve();
    expect(runs).toEqual(["first", "latest"]);
    expect(coordinator.active).toBe(true);
    releaseSecond.resolve();
    await coordinator.promise;
    expect(coordinator.active).toBe(false);
  });

  it("can suppress a queued rerun after a terminal inference failure", async () => {
    const coordinator = new ReflectionTaskCoordinator();
    const release = deferred<void>();
    const runs: string[] = [];
    const first = coordinator.start(async () => {
      runs.push("first");
      await release.promise;
      return false;
    });
    void coordinator.start(async () => {
      runs.push("queued");
    });

    release.resolve();
    expect(await first).toEqual({ status: "completed" });
    await Promise.resolve();
    expect(runs).toEqual(["first"]);
    expect(coordinator.active).toBe(false);
  });

  it("cancels the active task on lifecycle changes", async () => {
    const coordinator = new ReflectionTaskCoordinator();
    const task = coordinator.start(async signal => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    });

    void coordinator.start(async () => { throw new Error("queued run must be cleared"); });
    coordinator.cancel("session-switch");

    expect(await task).toEqual({ status: "cancelled", reason: "session-switch" });
    expect(coordinator.promise).toBeNull();
  });

  it("reports unexpected failures", async () => {
    const coordinator = new ReflectionTaskCoordinator();
    const error = new Error("failed");

    expect(await coordinator.start(async () => { throw error; })).toEqual({
      status: "failed",
      error,
    });
  });
});
