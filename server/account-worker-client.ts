import { fork, type ChildProcess } from "node:child_process";
import type { AccountFiles, Row } from "./account-files.ts";

export type WorkerError =
  | "登录已失效，需要重新登录"
  | "网络或超时，稍后自动重试"
  | "Provider 插件加载失败"
  | "未知错误";
export const workerErrors: readonly WorkerError[] = [
  "登录已失效，需要重新登录",
  "网络或超时，稍后自动重试",
  "Provider 插件加载失败",
  "未知错误",
];
export class AccountWorker {
  private workers = new Set<ChildProcess>();
  constructor(private files: AccountFiles) {}
  run(
    row: Row,
    operation: "refresh" | "login",
    onMessage?: (message: any) => void,
  ) {
    return new Promise<void>((resolve, reject) => {
      const directory = this.files.dir(row.number);
      const child = fork(
        new URL("./account-worker.mjs", import.meta.url),
        [directory, row.provider, operation],
        {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          execArgv: [],
          env: { ...process.env, PI_CODING_AGENT_DIR: directory },
        },
      );
      this.workers.add(child);
      let failure: WorkerError = "未知错误";
      const timer = setTimeout(
        () => {
          failure = "网络或超时，稍后自动重试";
          child.kill();
        },
        operation === "login" ? 5 * 60_000 : 30_000,
      );
      let done = false;
      child.on("message", (message: any) => {
        if (message?.kind === "done") done = true;
        if (
          message?.kind === "error" &&
          workerErrors.includes(message.category)
        )
          failure = message.category;
        onMessage?.(message);
      });
      child.once("error", () => {
        this.workers.delete(child);
        clearTimeout(timer);
        reject(new Error(failure));
      });
      child.once("exit", (code) => {
        this.workers.delete(child);
        clearTimeout(timer);
        done && code === 0 ? resolve() : reject(new Error(failure));
      });
      if (operation === "login") onMessage?.({ kind: "child", child });
    });
  }
  close() {
    for (const child of this.workers) child.kill();
  }
}
