export type ReflectionTaskCancellationReason =
  | "session-switch"
  | "session-fork"
  | "tree-navigation"
  | "session-shutdown";

export type ReflectionTaskResult =
  | { status: "completed" }
  | { status: "cancelled"; reason: ReflectionTaskCancellationReason }
  | { status: "failed"; error: unknown };

type ReflectionTaskRun = (signal: AbortSignal) => Promise<void>;

export class ReflectionTaskCoordinator {
  private controller: AbortController | null = null;
  private activePromise: Promise<ReflectionTaskResult> | null = null;
  private queuedRun: ReflectionTaskRun | null = null;

  get active(): boolean {
    return this.controller !== null;
  }

  get promise(): Promise<ReflectionTaskResult> | null {
    return this.activePromise;
  }

  start(run: ReflectionTaskRun): Promise<ReflectionTaskResult> {
    if (this.active) {
      this.queuedRun = run;
      return this.activePromise!;
    }

    const controller = new AbortController();
    this.controller = controller;
    const task = (async (): Promise<ReflectionTaskResult> => {
      try {
        await run(controller.signal);
        if (controller.signal.aborted) {
          return {
            status: "cancelled",
            reason: controller.signal.reason as ReflectionTaskCancellationReason,
          };
        }
        return { status: "completed" };
      } catch (error) {
        if (controller.signal.aborted) {
          return {
            status: "cancelled",
            reason: controller.signal.reason as ReflectionTaskCancellationReason,
          };
        }
        return { status: "failed", error };
      } finally {
        if (this.controller === controller) {
          this.controller = null;
          this.activePromise = null;
          const queuedRun = this.queuedRun;
          this.queuedRun = null;
          if (queuedRun) void this.start(queuedRun);
        }
      }
    })();
    this.activePromise = task;
    return task;
  }

  cancel(reason: ReflectionTaskCancellationReason): void {
    this.queuedRun = null;
    this.controller?.abort(reason);
  }
}
