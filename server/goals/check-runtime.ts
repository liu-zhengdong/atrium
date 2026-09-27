import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { Problem } from "../problem.ts";
import { all } from "../org/model.ts";
import { alive } from "../tasks/spawn.ts";
import { defaultBranch, exec, type Exec } from "../tasks/git.ts";
import { LocalCheckQueue } from "../tasks/local-check.ts";
import { workerEnvironment } from "../tasks/worker-env.ts";
import { goalRef, parseGoalRef, requireGoal, usage } from "./model.ts";
import { commandResult, summarize, type ItemState } from "./check-rules.ts";
import {
  checkRow,
  checkView,
  finishCheck,
  goalItems,
  insertCheck,
  sweepInterrupted,
  type CheckRow,
} from "./checks.ts";

/**
 * 命令型验收的执行（#313 第 2 步）：服务在里程碑仓库的临时 worktree（origin 默认分支，没有 origin 用 HEAD）
 * 里用白名单环境跑 `/bin/sh -c 命令`，独立进程组、有超时、串行排队；输出写日志，摘要抹凭据后落库。
 * 没填仓库的里程碑在空的临时目录里跑。跑完删掉临时目录。
 */

export const GOAL_CHECK_TIMEOUT_MS = 15 * 60_000;
const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

export type GoalCheckOptions = {
  data: string;
  timeoutMs?: number;
  run?: Exec;
  env?: NodeJS.ProcessEnv;
};

/** 日志尾部（最多 64 KB），从 from 字节起：跳过开头重复的命令行。 */
function logTail(file: string, from = 0): string {
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.max(0, Math.min(size - from, 64 * 1024));
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

export class GoalChecker {
  private readonly queue = new LocalCheckQueue();
  private readonly children = new Map<number, ChildProcess>();
  private closed = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: GoalCheckOptions,
  ) {
    try {
      sweepInterrupted(db, alive);
    } catch (error) {
      console.error(`目标判定：清理中断的检查失败：${String(error)}`);
    }
  }

  /** 跑命令条目：给 item 只跑那一条，否则跑全部命令条目；同一条正在跑就沿用，不重复起。 */
  start(reference: unknown, item: unknown, actor: string, now = Date.now()) {
    const id = parseGoalRef(reference, "目标");
    const goal = requireGoal(this.db, id);
    if (goal.status === "dropped")
      throw new Problem(409, `${goalRef(id)} 已放弃，不再判定`, "conflict");
    const items = goalItems(this.db, goal);
    let targets: ItemState<CheckRow>[];
    if (item === undefined || item === null) {
      targets = items.filter((i) => i.command);
      if (!targets.length)
        throw usage(
          `${goalRef(id)} 没有命令条目（以 $ 开头）；人工判用 --item N --pass|--fail --note 证据`,
          `atrium goal show ${goalRef(id)}`,
        );
    } else {
      if (typeof item !== "number" || !Number.isInteger(item) || item < 1)
        throw usage("--item: 应为正整数，如 --item 2");
      const found = items[item - 1];
      if (!found)
        throw usage(
          `--item: ${goalRef(id)} 只有 ${items.length} 条验收标准`,
          `atrium goal show ${goalRef(id)}`,
        );
      if (!found.command)
        throw usage(
          `--item: 第 ${item} 条不是命令，要人工判：加 --pass 或 --fail 和 --note 证据`,
          `atrium goal check ${goalRef(id)} --item ${item} --pass --note 证据`,
        );
      targets = [found];
    }
    const started: CheckRow[] = [];
    for (const target of targets) {
      const running =
        target.latest?.result === "running" ? target.latest : null;
      if (running) {
        started.push(running);
        continue;
      }
      const checkId = insertCheck(this.db, {
        goal_id: id,
        criterion: target.text,
        kind: "command",
        result: "running",
        owner: process.pid,
        actor,
        at: now,
      });
      started.push(checkRow(this.db, checkId)!);
      void this.execute(checkId, id, target.command!, goal.repo);
    }
    return { goal: goalRef(id), checks: started.map(checkView) };
  }

  /** 等这些判定跑完（服务端长轮询）；按库轮询，跨平滑重启的新旧服务都看得到。 */
  async wait(
    reference: unknown,
    ids: unknown,
    seconds: number,
    signal?: AbortSignal,
  ) {
    const id = parseGoalRef(reference, "目标");
    requireGoal(this.db, id);
    const list =
      typeof ids === "string" && ids
        ? ids.split(",").map((part) => Number(part))
        : [];
    if (
      !list.length ||
      list.length > 20 ||
      list.some((n) => !Number.isSafeInteger(n) || n < 1)
    )
      throw usage("ids: 判定编号用逗号分隔，最多 20 个");
    const deadline = Date.now() + seconds * 1000;
    const read = () =>
      all<CheckRow>(
        this.db,
        `SELECT * FROM goal_checks WHERE goal_id=? AND id IN (${list.map(() => "?").join(",")}) ORDER BY id`,
        id,
        ...list,
      );
    for (;;) {
      if (this.closed) return { checks: [], timed_out: true, restarting: true };
      const rows = read();
      const pending = rows.some((r) => r.result === "running");
      if (!pending || Date.now() >= deadline || signal?.aborted)
        return { checks: rows.map(checkView), timed_out: pending };
      await delay(Math.min(300, Math.max(1, deadline - Date.now())));
    }
  }

  /** 服务关闭：杀掉在跑的检查进程组，判为没跑成（下一个服务不会接着跑）。 */
  close() {
    this.closed = true;
    for (const [checkId, child] of this.children) {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* 已退出 */
        }
      try {
        finishCheck(this.db, checkId, {
          result: "error",
          exit_code: null,
          summary: "服务停止，检查中断；重跑 atrium goal check",
          log: null,
        });
      } catch {
        /* 数据库已关：下一个服务启动时按进程号判中断 */
      }
    }
    this.children.clear();
  }

  private async execute(
    checkId: number,
    goalId: number,
    command: string,
    repo: string | null,
  ) {
    const base = join(this.options.data, "goals", goalRef(goalId));
    const log = join(base, `check-${checkId}.log`);
    const work = join(base, `work-${checkId}`);
    try {
      await this.queue.run(async () => {
        if (this.closed) return;
        mkdirSync(base, { recursive: true, mode: 0o700 });
        const fd = openSync(log, "w", 0o600);
        let prepared: { cleanup: () => Promise<void> } | null = null;
        let outcome: Parameters<typeof finishCheck>[2];
        const from = writeSync(fd, `$ ${command}\n`);
        try {
          prepared = await this.prepare(work, repo, fd);
          const runOutcome = await this.spawn(checkId, command, work, fd);
          closeSync(fd);
          const output = summarize(logTail(log, from));
          outcome = {
            ...runOutcome,
            summary:
              runOutcome.result === "timeout" || !output
                ? [output, runOutcome.detail].filter(Boolean).join("\n")
                : output,
            log,
          };
        } catch (error) {
          try {
            closeSync(fd);
          } catch {
            /* 已关 */
          }
          const message =
            error instanceof Error ? error.message : String(error);
          outcome = {
            result: "error",
            exit_code: null,
            summary: summarize(message),
            log,
          };
        } finally {
          await prepared?.cleanup().catch(() => undefined);
          rmSync(work, { recursive: true, force: true });
        }
        // 等 worktree 注销、目录删除后才公布结论；wait 的调用方据此可立即检查现场。
        finishCheck(this.db, checkId, outcome);
      });
    } catch (error) {
      if (this.closed) return;
      console.error(`目标判定 ${checkId} 失败：${String(error)}`);
    }
  }

  /** 隔离环境：有仓库就从 origin 默认分支（没有 origin 用 HEAD）检出只读用途的临时 worktree。 */
  private async prepare(work: string, repo: string | null, fd: number) {
    rmSync(work, { recursive: true, force: true });
    if (!repo) {
      mkdirSync(work, { recursive: true, mode: 0o700 });
      writeSync(fd, `# 在空的临时目录里执行（里程碑没填 --repo）\n`);
      return { cleanup: async () => undefined };
    }
    const run = this.options.run ?? exec;
    const top = await run("git", ["-C", repo, "rev-parse", "--show-toplevel"], {
      timeoutMs: 10_000,
    });
    if (!top.ok)
      throw new Error(`${repo} 不是 git 仓库：${firstLine(top.stderr)}`);
    let ref = "HEAD";
    const branch = await defaultBranch(repo, run).catch(() => null);
    if (branch) {
      const fetched = await run(
        "git",
        ["-C", repo, "fetch", "origin", branch],
        {
          timeoutMs: 120_000,
        },
      );
      if (!fetched.ok)
        throw new Error(
          `拉取 origin/${branch} 失败：${firstLine(fetched.stderr)}`,
        );
      ref = `origin/${branch}`;
    }
    const added = await run(
      "git",
      ["-C", repo, "worktree", "add", "--detach", work, ref],
      { timeoutMs: 60_000 },
    );
    if (!added.ok)
      throw new Error(`建临时工作树失败：${firstLine(added.stderr)}`);
    const head = await run(
      "git",
      ["-C", work, "rev-parse", "--short", "HEAD"],
      {
        timeoutMs: 10_000,
      },
    );
    writeSync(fd, `# ${repo} @ ${ref} ${head.stdout.trim()}（临时工作树）\n`);
    return {
      cleanup: async () => {
        await run("git", ["-C", repo, "worktree", "remove", "--force", work], {
          timeoutMs: 60_000,
        });
        await run("git", ["-C", repo, "worktree", "prune"], {
          timeoutMs: 30_000,
        });
      },
    };
  }

  private spawn(checkId: number, command: string, cwd: string, fd: number) {
    const timeoutMs = this.options.timeoutMs ?? GOAL_CHECK_TIMEOUT_MS;
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: workerEnvironment(this.options.env),
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    this.children.set(checkId, child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* 已退出 */
        }
    }, timeoutMs);
    return new Promise<{
      result: "pass" | "fail" | "timeout" | "error";
      exit_code: number | null;
      detail: string;
    }>((resolve) => {
      const finish = (code: number | null, error?: Error) => {
        clearTimeout(timer);
        this.children.delete(checkId);
        const result = commandResult({ code, timedOut, error: error?.message });
        resolve({
          result,
          exit_code: code,
          detail: timedOut
            ? `超过 ${Math.ceil(timeoutMs / 1000)} 秒`
            : (error?.message ?? `退出码 ${code}`),
        });
      };
      child.once("error", (error) => finish(null, error));
      child.once("close", (code) => finish(code));
    });
  }
}
