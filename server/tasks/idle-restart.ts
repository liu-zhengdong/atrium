import { Problem } from "../problem.ts";
import { alive, currentVersion } from "../service-state.ts";
import {
  readRestartState,
  startSupervisor,
  writeRestartState,
  type RestartState,
} from "../supervisor.ts";
import type { TaskRunner } from "./runner.ts";

/** The decision is independent of timers, the ledger, and process management. */
export function idleDecision(
  now: number,
  deadline: number,
  running: readonly string[],
) {
  if (running.length === 0) return "restart" as const;
  return now >= deadline ? ("timeout" as const) : ("wait" as const);
}

/** Service-owned bridge between the durable restart request and the existing supervisor. */
export class IdleRestart {
  private timer?: NodeJS.Timeout;
  private transitioning = false;

  constructor(
    private readonly data: string,
    private readonly runner: TaskRunner,
    private readonly launch: (data: string) => Promise<unknown> = (data) =>
      startSupervisor({ data }),
    private readonly canResume: () => boolean = () => true,
  ) {
    this.runner.setRestartPending(
      readRestartState(data)?.status === "waiting_idle",
    );
  }

  /** Begin only after the HTTP listener is ready for the supervisor's drain request. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(console.error), 250);
    this.timer.unref();
    void this.tick().catch(console.error);
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  status() {
    const state = readRestartState(this.data);
    return state?.status === "waiting_idle"
      ? {
          pending: true,
          running: this.runner.runningTaskRefs(),
          deadline: state.idleDeadline,
        }
      : null;
  }

  schedule(timeoutMs: number) {
    const previous = readRestartState(this.data);
    if (previous?.status === "waiting_idle")
      throw new Problem(
        409,
        "已有待重启请求；运行 atrium status 查看进度",
        "conflict",
      );
    if (
      previous &&
      ["stopping", "starting", "checking", "rolling_back"].includes(
        previous.status,
      ) &&
      previous.supervisorPid > 0 &&
      alive(previous.supervisorPid)
    )
      throw new Problem(
        409,
        "重启已在进行中；运行 atrium restart --wait",
        "conflict",
      );
    const now = Date.now();
    const state: RestartState = {
      id: `rst-${now}`,
      status: "waiting_idle",
      supervisorPid: 0,
      startedAt: now,
      idleDeadline: now + timeoutMs,
      fromVersion: currentVersion(),
      data: this.data,
    };
    writeRestartState(this.data, state);
    this.runner.setRestartPending(true);
    const running = this.runner.runningTaskRefs();
    setImmediate(() => void this.tick().catch(console.error));
    return {
      task_id: state.id,
      pending: true,
      running,
      deadline: state.idleDeadline,
    };
  }

  async tick(now = Date.now()) {
    if (this.transitioning) return;
    const state = readRestartState(this.data);
    if (state?.status !== "waiting_idle") {
      if (
        this.runner.isRestartPending() &&
        state?.status === "stopping" &&
        state.supervisorPid > 0 &&
        !alive(state.supervisorPid)
      ) {
        writeRestartState(this.data, {
          ...state,
          status: "failed",
          finishedAt: now,
          error: "重启 supervisor 已退出；旧服务恢复派发排队任务",
        });
        await this.release();
        return;
      }
      if (state?.status === "failed" || state?.status === "idle_timeout")
        await this.release();
      return;
    }
    const running = this.runner.runningTaskRefs();
    const decision = idleDecision(
      now,
      state.idleDeadline ?? state.startedAt + 1_800_000,
      running,
    );
    if (decision === "wait") return;
    this.transitioning = true;
    try {
      if (decision === "timeout") {
        writeRestartState(this.data, {
          ...state,
          status: "idle_timeout",
          remainingTasks: running,
          error: `等待执行者结束超时；仍在运行：${running.join("、")}`,
          finishedAt: now,
        });
        console.warn(`待重启超时，未强制停止执行者：${running.join("、")}`);
        await this.release();
      } else {
        await this.launch(this.data);
      }
    } catch (error) {
      writeRestartState(this.data, {
        ...state,
        status: "failed",
        error: `启动 supervisor 失败：${String(error)}`,
        finishedAt: Date.now(),
      });
      console.error("待重启未能启动：", error);
      await this.release();
    } finally {
      this.transitioning = false;
    }
  }

  private async release() {
    if (!this.runner.isRestartPending()) return;
    if (!this.canResume()) return;
    this.runner.setRestartPending(false);
    await this.runner.resumeQueue();
  }
}
