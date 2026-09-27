import { execFile } from "node:child_process";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { redact } from "../secret-redact.ts";
import { packageRoot } from "../service-state.ts";
import { readRestartState } from "../supervisor.ts";
import { firstLine, type Exec } from "./git.ts";
import { originRepo, repoFlag } from "./gh-repo.ts";
import { atomically, getTask, noteTask } from "./ledger.ts";
import type { TaskRow } from "./ledger-model.ts";
import {
  firstRelease,
  onlineMessage,
  planOnline,
  RELEASE_OVERDUE_MS,
  verificationSection,
} from "./online.ts";

export type DeployResult = { ok: true } | { ok: false; reason: string };

/** 自升级后多久还没被新服务接替，就认为这次重启没有发生。 */
const RESTART_GRACE_MS = 10 * 60_000;

/**
 * 自动上线（#325 第 3 步）：已合入、属于服务自身仓库的任务等发版；版本比运行中的新就
 * update + restart，新服务起来后再判一次，标记「已上线」并把执行者写的端到端验证附进通知。
 * 进度全在账本（release_version、online_attempt、online_wait），重启后照常续上。
 */
export class OnlineWatch {
  private running = false;
  private closed = false;
  private restartingUntil = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: {
      run: Exec;
      /** 正在运行的服务版本。 */
      version: () => string;
      selfUpdate: boolean;
      /** 合入进行中或别处正在重启时先不重启。 */
      busy: () => boolean;
      deploy: (version: string) => Promise<DeployResult>;
      /** 上次重启失败或回滚的原因（读 restart-state.json）；没有返回 null。 */
      restartError?: (version: string) => string | null;
      publish: (
        id: number,
        kind: string,
        detail: Record<string, unknown>,
      ) => void;
      changed: (id: number) => void;
      now?: () => number;
    },
  ) {}

  close() {
    this.closed = true;
  }

  kick() {
    if (this.closed || this.running) return;
    void this.tick().catch((error) =>
      console.error("自动上线失败：", redact(String(error))),
    );
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private rows() {
    return this.db
      .prepare(
        "SELECT * FROM tasks WHERE delivery_stage='merged' AND online_wait=1 ORDER BY id LIMIT 100",
      )
      .all() as TaskRow[];
  }

  async tick() {
    if (this.closed || this.running || this.now() < this.restartingUntil)
      return;
    this.running = true;
    try {
      let rows = this.rows();
      if (!rows.length) return;
      await this.findReleases(rows.filter((row) => !row.release_version));
      if (this.closed) return;
      rows = this.rows();
      const current = this.options.version();
      const plan = planOnline(
        rows.map((row) => ({
          id: row.id,
          release: row.release_version,
          attempted: row.online_attempt,
        })),
        current,
        { selfUpdate: this.options.selfUpdate, busy: this.options.busy() },
      );
      for (const id of plan.online) await this.online(id, current);
      for (const id of plan.failed) {
        const task = getTask(this.db, id);
        this.fail(
          id,
          this.options.restartError?.(task.online_attempt ?? "") ??
            `已为 v${task.online_attempt} 自升级并重启，运行版本仍是 v${current}`,
        );
      }
      for (const id of plan.skipped) {
        atomically(this.db, () => {
          this.db
            .prepare("UPDATE tasks SET online_wait=0,updated_at=? WHERE id=?")
            .run(this.now(), id);
          noteTask(this.db, id, "online_skipped", {
            reason:
              "本服务不自升级（开发中的检出、另给 ATRIUM_DATA 的隔离服务或 ATRIUM_SELF_UPDATE=0），停在已合入",
          });
        });
        this.options.changed(id);
      }
      if (plan.deploy && !this.closed) await this.deploy(plan);
    } finally {
      this.running = false;
    }
  }

  /** 按仓库拉一次标签，找含合入提交的最早版本；超时没发版提醒一次。 */
  private async findReleases(rows: TaskRow[]) {
    const fetched = new Map<string, boolean>();
    for (const row of rows) {
      if (this.closed || !row.repo) return;
      let commit = row.merge_commit;
      if (!commit) commit = await this.mergeCommit(row);
      if (commit) {
        if (!fetched.has(row.repo)) {
          const fetch = await this.options.run(
            "git",
            ["-C", row.repo, "fetch", "--quiet", "--tags", "--force", "origin"],
            { timeoutMs: 120_000 },
          );
          if (!fetch.ok)
            console.error(
              "自动上线拉取标签失败：",
              redact(firstLine(fetch.stderr)),
            );
          fetched.set(row.repo, fetch.ok);
        }
        if (fetched.get(row.repo)) {
          const tags = await this.options.run("git", [
            "-C",
            row.repo,
            "tag",
            "--contains",
            commit,
            "--list",
            "v*",
          ]);
          const version = tags.ok ? firstRelease(tags.stdout) : null;
          if (version) {
            atomically(this.db, () => {
              this.db
                .prepare(
                  "UPDATE tasks SET release_version=?,updated_at=? WHERE id=?",
                )
                .run(version, this.now(), row.id);
              noteTask(this.db, row.id, "released", { version });
            });
            this.options.changed(row.id);
            continue;
          }
        }
      }
      this.overdue(row);
    }
  }

  private async mergeCommit(row: TaskRow) {
    if (!row.pr_url || !row.repo) return null;
    const origin = await originRepo(row.repo, this.options.run);
    if ("error" in origin) return null;
    const view = await this.options.run("gh", [
      "pr",
      "view",
      row.pr_url,
      "-R",
      repoFlag(origin.repo),
      "--json",
      "mergeCommit",
    ]);
    if (!view.ok) return null;
    try {
      const oid = (
        JSON.parse(view.stdout) as { mergeCommit?: { oid?: unknown } }
      ).mergeCommit?.oid;
      if (typeof oid !== "string" || !/^[0-9a-f]{7,64}$/i.test(oid))
        return null;
      this.db
        .prepare("UPDATE tasks SET merge_commit=? WHERE id=?")
        .run(oid, row.id);
      return oid;
    } catch {
      return null;
    }
  }

  private overdue(row: TaskRow) {
    const merged = this.db
      .prepare(
        "SELECT at FROM task_events WHERE task_id=? AND kind='merged' ORDER BY id DESC LIMIT 1",
      )
      .get(row.id) as { at: number } | undefined;
    if (!merged || this.now() - merged.at < RELEASE_OVERDUE_MS) return;
    const told = this.db
      .prepare(
        "SELECT 1 FROM task_events WHERE task_id=? AND kind='release_overdue' AND id>(SELECT MAX(id) FROM task_events WHERE task_id=? AND kind='merged') LIMIT 1",
      )
      .get(row.id, row.id);
    if (told) return;
    const reason = `合入 ${Math.round(RELEASE_OVERDUE_MS / 60_000)} 分钟仍没有含它的版本；查看仓库的发版工作流`;
    noteTask(this.db, row.id, "release_overdue", { reason });
    this.options.publish(row.id, "release_overdue", { reason });
  }

  private async online(id: number, current: string) {
    const task = getTask(this.db, id);
    let body: string | null = null;
    if (task.pr_url && task.repo) {
      const origin = await originRepo(task.repo, this.options.run);
      if (!("error" in origin)) {
        const view = await this.options.run("gh", [
          "pr",
          "view",
          task.pr_url,
          "-R",
          repoFlag(origin.repo),
          "--json",
          "body",
        ]);
        if (view.ok)
          try {
            const value = (JSON.parse(view.stdout) as { body?: unknown }).body;
            if (typeof value === "string") body = value;
          } catch {
            /* 读不到正文就退回执行者汇报。 */
          }
      }
    }
    const verification =
      verificationSection(body) ?? verificationSection(task.result);
    const message = onlineMessage(task.ref, current);
    atomically(this.db, () => {
      this.db
        .prepare(
          "UPDATE tasks SET delivery_stage='online',online_wait=0,updated_at=? WHERE id=?",
        )
        .run(this.now(), id);
      noteTask(this.db, id, "online", {
        version: current,
        release: task.release_version,
        verification: verification !== null,
      });
    });
    this.options.changed(id);
    this.options.publish(id, "online", {
      message,
      version: current,
      release: task.release_version,
      verification:
        verification ?? "执行者没有写「端到端验证」一节；请按任务目标自行验证",
    });
  }

  private fail(id: number, why: string) {
    const reason = redact(why);
    atomically(this.db, () => {
      this.db
        .prepare("UPDATE tasks SET online_wait=0,updated_at=? WHERE id=?")
        .run(this.now(), id);
      noteTask(this.db, id, "online_failed", { reason });
    });
    this.options.changed(id);
    this.options.publish(id, "online_failed", { reason });
  }

  private async deploy(plan: { deploy: string | null; deploying: number[] }) {
    const version = plan.deploy!;
    // 先记账再升级：服务在升级中途被换掉，新服务据此判断这次升级有没有生效，不反复升级同一版本。
    atomically(this.db, () => {
      for (const id of plan.deploying) {
        this.db
          .prepare("UPDATE tasks SET online_attempt=?,updated_at=? WHERE id=?")
          .run(version, this.now(), id);
        noteTask(this.db, id, "online_deploy", { version });
      }
    });
    for (const id of plan.deploying) this.options.changed(id);
    const result = await this.options.deploy(version);
    if (result.ok) {
      this.restartingUntil = this.now() + RESTART_GRACE_MS;
      return;
    }
    for (const id of plan.deploying)
      this.fail(id, `自升级到 v${version} 失败：${result.reason}`);
  }
}

/** 默认自升级：用本包的命令行 `update --to` 装新版，再 `restart` 让 supervisor 换掉本服务。 */
export function cliDeploy(data: string, env: NodeJS.ProcessEnv = process.env) {
  const bin = join(packageRoot, "bin", "atrium.mjs");
  const cli = (args: string[], timeout: number) =>
    new Promise<{ ok: boolean; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [bin, ...args],
        {
          timeout,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...env, ATRIUM_DATA: data },
        },
        (error, _stdout, stderr) =>
          resolve({
            ok: !error,
            stderr: String(stderr || (error ? error.message : "")),
          }),
      );
    });
  return async (version: string): Promise<DeployResult> => {
    const update = await cli(["update", "--to", version], 10 * 60_000);
    if (!update.ok)
      return {
        ok: false,
        reason: `atrium update：${redact(firstLine(update.stderr)) || "执行失败"}`,
      };
    const restart = await cli(["restart"], 60_000);
    if (!restart.ok)
      return {
        ok: false,
        reason: `atrium restart：${redact(firstLine(restart.stderr)) || "执行失败"}`,
      };
    return { ok: true };
  };
}

/** 最近一次重启回滚或失败的原因，给上线失败的通知用。 */
export function lastRestartError(data: string, version: string) {
  const state = readRestartState(data);
  if (
    !state ||
    (state.status !== "rolled_back" && state.status !== "failed") ||
    (state.targetVersion !== version && state.failedVersion !== version)
  )
    return null;
  return `自升级重启${state.status === "rolled_back" ? `已回滚到 v${state.rollbackVersion ?? state.fromVersion}` : "失败"}：${state.error ?? "未知原因"}`;
}
