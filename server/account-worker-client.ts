import { fork, type ChildProcess } from "node:child_process";
import type { AccountFiles, Row } from "./account-files.ts";
import type { ProviderEntry } from "../shared/providers.ts";
import type { Validation } from "./account-validation.ts";

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
/** 校验子进程退出时按事实分开报，不再一律「网络不可用」（#223）。 */
export function validationExitReason(input: {
  timedOut: boolean;
  phase: string;
  elapsedMs: number;
  errorMessage?: string;
  code: number | null;
}): string {
  if (input.timedOut)
    return `校验超时：等了 ${Math.round(input.elapsedMs / 1000)} 秒未完成，卡在「${input.phase}」`;
  if (input.errorMessage === "Provider 插件加载失败") return input.errorMessage;
  if (input.errorMessage) return `校验进程报错：${input.errorMessage}`;
  return `校验进程退出未返回结果（退出码 ${input.code ?? "?"}）`;
}

export class AccountWorker {
  private workers = new Set<ChildProcess>();
  /** 校验子进程单独成组（detached），超时时能连同它派生的 npm 一起杀掉。 */
  private grouped = new Set<ChildProcess>();
  constructor(private files: AccountFiles) {}
  list(directory: string): Promise<ProviderEntry[]> {
    return new Promise((resolve, reject) => {
      const child = fork(
        new URL("./account-worker.mjs", import.meta.url),
        [directory, "", "list"],
        {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          execArgv: [],
          env: { ...process.env, PI_CODING_AGENT_DIR: directory },
        },
      );
      this.workers.add(child);
      let result: ProviderEntry[] | undefined;
      const timer = setTimeout(() => child.kill(), 30_000);
      child.on(
        "message",
        (message: {
          kind: string;
          providers?: ProviderEntry[];
          count?: number;
        }) => {
          if (message.kind === "list") result = message.providers;
          if (message.kind === "warning")
            console.warn(`供应商目录跳过 ${message.count} 个加载失败的插件`);
        },
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        this.workers.delete(child);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        this.workers.delete(child);
        if (code === 0 && result) resolve(result);
        else reject(new Error("供应商目录加载失败"));
      });
    });
  }
  validate(
    directory: string,
    provider: string,
    key: string,
  ): Promise<Validation> {
    return new Promise((resolve) => {
      const child = fork(
        new URL("./account-worker.mjs", import.meta.url),
        [directory, provider, "validate"],
        {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          execArgv: [],
          detached: true,
          env: { ...process.env, PI_CODING_AGENT_DIR: directory },
        },
      );
      this.workers.add(child);
      this.grouped.add(child);
      let result: Validation | undefined;
      let phase = "加载插件";
      let errorMessage: string | undefined;
      let timedOut = false;
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        timedOut = true;
        this.killWorker(child);
      }, 15_000);
      child.on(
        "message",
        (message: {
          kind: string;
          status?: Validation["status"];
          reason?: string;
          phase?: string;
          category?: string;
        }) => {
          if (message.kind === "validation" && message.status)
            result = {
              status: message.status,
              reason: message.reason?.replaceAll(key, "[凭据已隐藏]"),
            };
          else if (message.kind === "phase" && message.phase === "request")
            phase = "请求供应商";
          else if (
            message.kind === "error" &&
            message.category &&
            workerErrors.includes(message.category as WorkerError)
          )
            errorMessage = message.category;
        },
      );
      child.once("error", () => {
        clearTimeout(timer);
        this.workers.delete(child);
        this.grouped.delete(child);
        resolve({ status: "unverified", reason: "校验进程失败" });
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        this.workers.delete(child);
        this.grouped.delete(child);
        resolve(
          result ?? {
            status: "unverified",
            reason: validationExitReason({
              timedOut,
              phase,
              elapsedMs: Date.now() - startedAt,
              errorMessage,
              code,
            }),
          },
        );
      });
    });
  }
  /** 超时与关闭都走这里：校验子进程有组，整组杀，不给临时目录留 npm。 */
  private killWorker(child: ChildProcess) {
    if (child.pid !== undefined && this.grouped.has(child)) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        /* 回退：只杀直接子进程 */
      }
    }
    child.kill();
  }
  run(
    row: Row,
    operation: "refresh" | "login",
    onMessage?: (message: any) => void,
    directoryOverride?: string,
  ) {
    return new Promise<void>((resolve, reject) => {
      const directory = directoryOverride ?? this.files.dir(row.number);
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
    for (const child of this.workers) this.killWorker(child);
  }
}
