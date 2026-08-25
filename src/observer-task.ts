export type ObserverTaskCancellationReason =
  | "turn-aborted"
  | "session-switch"
  | "session-fork"
  | "tree-navigation"
  | "session-shutdown"
  | "session-changed"
  | "branch-changed";

export interface ObserverTaskSession {
  getSessionId(): string | undefined;
  getLeafId(): string | null | undefined;
  getBranch(): readonly { id: string }[];
}

export type ObserverTaskResult =
  | { status: "completed" }
  | { status: "skipped"; reason: "already-active" }
  | { status: "cancelled"; reason: ObserverTaskCancellationReason }
  | { status: "failed"; error: unknown };

export interface ObserverTaskContext {
  signal: AbortSignal;
  throwIfCancelled(): void;
  commitSync<T>(commit: () => T): T;
}

interface StartObserverTaskOptions {
  session: ObserverTaskSession;
  signal?: AbortSignal;
  run(context: ObserverTaskContext): Promise<void>;
}

class ObserverTaskCancelled extends Error {
  constructor(readonly reason: ObserverTaskCancellationReason) {
    super(`observer task cancelled: ${reason}`);
    this.name = "ObserverTaskCancelled";
  }
}

export class ObserverTaskCoordinator {
  private controller: AbortController | null = null;
  private activePromise: Promise<ObserverTaskResult> | null = null;

  get active(): boolean {
    return this.controller !== null;
  }

  get promise(): Promise<ObserverTaskResult> | null {
    return this.activePromise;
  }

  start(options: StartObserverTaskOptions): Promise<ObserverTaskResult> {
    if (this.active) return Promise.resolve({ status: "skipped", reason: "already-active" });

    const controller = new AbortController();
    this.controller = controller;
    const originSessionId = options.session.getSessionId();
    const originLeafId = options.session.getLeafId();
    const abortFromTurn = () => controller.abort("turn-aborted");
    if (options.signal?.aborted) abortFromTurn();
    else options.signal?.addEventListener("abort", abortFromTurn, { once: true });

    const throwIfCancelled = (): void => {
      if (!controller.signal.aborted) return;
      const reason = controller.signal.reason;
      throw new ObserverTaskCancelled(
        typeof reason === "string"
          ? reason as ObserverTaskCancellationReason
          : "turn-aborted",
      );
    };

    const commitSync = <T>(commit: () => T): T => {
      throwIfCancelled();
      if (options.session.getSessionId() !== originSessionId) {
        throw new ObserverTaskCancelled("session-changed");
      }
      const branchContainsOrigin = originLeafId !== null
        && originLeafId !== undefined
        && options.session.getBranch().some(entry => entry.id === originLeafId);
      if (!branchContainsOrigin) throw new ObserverTaskCancelled("branch-changed");
      return commit();
    };

    const task = (async (): Promise<ObserverTaskResult> => {
      try {
        throwIfCancelled();
        await options.run({ signal: controller.signal, throwIfCancelled, commitSync });
        throwIfCancelled();
        return { status: "completed" };
      } catch (error) {
        if (error instanceof ObserverTaskCancelled) {
          return { status: "cancelled", reason: error.reason };
        }
        return { status: "failed", error };
      } finally {
        options.signal?.removeEventListener("abort", abortFromTurn);
        if (this.controller === controller) {
          this.controller = null;
          this.activePromise = null;
        }
      }
    })();

    this.activePromise = task;
    return task;
  }

  cancel(reason: ObserverTaskCancellationReason): void {
    this.controller?.abort(reason);
  }
}
