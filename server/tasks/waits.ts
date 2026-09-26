import { EventEmitter } from "node:events";
import { taskRef, type Task } from "./ledger.ts";

/**
 * 等某个任务结束的长轮询（#262）：任务状态变化时由运行时通知；
 * settled 返回非空（任务已离开 running、不在排队、不在启动）即返回，超时或服务关闭也返回。
 */
export class TaskWaits {
  private readonly changes = new EventEmitter();
  private closed = false;

  constructor(
    private readonly settled: (id: number) => Task | null,
    private readonly current: (id: number) => Task,
  ) {
    this.changes.setMaxListeners(0);
  }

  changed(id: number) {
    this.changes.emit("change", id);
  }

  close() {
    this.closed = true;
    this.changes.emit("close");
  }

  wait(
    id: number,
    seconds: number,
    signal?: AbortSignal,
  ): Promise<{ task: Task; timed_out: boolean; restarting?: boolean }> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (restarting = false) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.changes.off("change", changed);
        this.changes.off("close", closing);
        signal?.removeEventListener("abort", aborted);
        // 服务关闭时数据库可能已关，不再读账本。
        const task = this.closed ? null : this.settled(id);
        resolve({
          task:
            task ??
            (this.closed ? ({ ref: taskRef(id) } as Task) : this.current(id)),
          timed_out: !task,
          ...(restarting ? { restarting: true } : {}),
        });
      };
      const changed = (changedId: number) => {
        if (changedId === id && this.settled(id)) finish();
      };
      const closing = () => finish(true);
      const aborted = () => finish();
      const timer = setTimeout(() => finish(), seconds * 1000);
      this.changes.on("change", changed);
      this.changes.on("close", closing);
      signal?.addEventListener("abort", aborted);
    });
  }
}
