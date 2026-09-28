import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { runFile } from "../platform/index.ts";
import { redact } from "../secret-redact.ts";
import { packageRoot } from "../service-state.ts";
import { readRestartState } from "../supervisor.ts";
import { firstLine, type Exec } from "./git.ts";
import { originRepo, repoFlag } from "./gh-repo.ts";
import { atomically, getTask, noteTask } from "./ledger.ts";
import type { TaskRow } from "./ledger-model.ts";
import { backfillLegacyPage } from "./online-backfill.ts";
import {
  firstRelease,
  includedInVersion,
  onlineMessage,
  planOnline,
  RELEASE_OVERDUE_MS,
  verificationSection,
} from "./online.ts";
import { compareSemver } from "../releases.ts";
import {
  overdueFailure,
  releaseFailure,
  releaseVerdict,
  type ReleaseVerdict,
} from "./release-run.ts";
import { markReleaseFailed, ReleaseRuns } from "./release-watch.ts";

export type DeployResult = { ok: true } | { ok: false; reason: string };

/** 自升级后多久还没被新服务接替，就认为这次重启没有发生。 */
const RESTART_GRACE_MS = 10 * 60_000;

/**
 * 自动上线（#325 第 3 步）：已合入、属于服务自身仓库的任务等发版；版本比运行中的新就
 * update + restart，新服务起来后再判一次，标记「已上线」并把执行者写的端到端验证附进通知；
 * 同一事务里建上线验证任务（t181，verify-runtime.ts），提交后派人照着跑；派了人的通知只是知会，
 * 没通过或无法验证才叫醒负责人（t182）。
 * 进度全在账本（release_version、online_attempt、online_wait），重启后照常续上。
 */
export class OnlineWatch {
  private running = false;
  private closed = false;
  private restartingUntil = 0;
  private legacyCursor = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: {
      run: Exec;
      /** 正在运行的服务版本。 */
      version: () => string;
      selfUpdate: boolean;
      /** 历史任务只核对自身仓库，避免把别的项目误记为本服务已上线。 */
      selfRepo?: string | null;
      /** 合入进行中或别处正在重启时先不重启。 */
      busy: () => boolean;
      /** 有紧急任务要上线时（t215）只看这个：别的紧急任务在合入、或别处正在重启；缺省同 busy。 */
      urgentBusy?: () => boolean;
      deploy: (version: string) => Promise<DeployResult>;
      /** 上次重启失败或回滚的原因（读 restart-state.json）；没有返回 null。 */
      restartError?: (version: string) => string | null;
      publish: (
        id: number,
        kind: string,
        detail: Record<string, unknown>,
      ) => void;
      changed: (id: number) => void;
      /**
       * 上线后的端到端验证（t181）：open 在「已上线」同一事务里建验证任务（没有验证步骤记一笔、返回 null），
       * dispatch 在提交后派人。
       */
      verify?: {
        open: (
          id: number,
          steps: string | null,
          version: string,
        ) => string | null;
        dispatch: (refs: string[]) => void;
      };
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
      if (!rows.length) {
        await this.backfillLegacy(this.options.version());
        return;
      }
      await this.findReleases(rows.filter((row) => !row.release_version));
      if (this.closed) return;
      rows = this.rows();
      const current = this.options.version();
      const plan = planOnline(
        rows.map((row) => ({
          id: row.id,
          release: row.release_version,
          attempted: row.online_attempt,
          urgent: row.urgent === 1,
        })),
        current,
        {
          selfUpdate: this.options.selfUpdate,
          busy: this.options.busy(),
          urgentBusy: (this.options.urgentBusy ?? this.options.busy)(),
        },
      );
      const published: {
        id: number;
        detail: Awaited<ReturnType<OnlineWatch["prepareOnline"]>>;
      }[] = [];
      for (const id of plan.online)
        published.push({ id, detail: await this.prepareOnline(id, current) });
      // 状态和通知一同提交；同一版本连续入队，秘书的攒批唤醒只处理一批。
      const verifiers: string[] = [];
      atomically(this.db, () => {
        for (const item of published) {
          this.db
            .prepare(
              "UPDATE tasks SET delivery_stage='online',online_wait=0,updated_at=? WHERE id=?",
            )
            .run(this.now(), item.id);
          noteTask(this.db, item.id, "online", {
            version: current,
            release: item.detail.release,
            verification: item.detail.steps !== null,
            // 总任务整体上线时汇总各子任务的端到端验证（t190）。
            ...(item.detail.steps !== null
              ? { verification_text: item.detail.steps.slice(0, 1000) }
              : {}),
          });
          const verifier =
            this.options.verify?.open(item.id, item.detail.steps, current) ??
            null;
          if (verifier) verifiers.push(verifier);
          const { steps: _, ...detail } = item.detail;
          this.options.publish(item.id, "online", {
            ...detail,
            ...(verifier ? { verifier } : {}),
          });
        }
      });
      for (const item of published) this.options.changed(item.id);
      if (verifiers.length) this.options.verify?.dispatch(verifiers);
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
      if (!this.closed) await this.backfillLegacy(current);
    } finally {
      this.running = false;
    }
  }

  /** 旧任务没有 online_wait；查过（含无结果、别的仓库）即记下，不再起子进程。 */
  private async backfillLegacy(current: string) {
    if (!this.options.selfRepo) return;
    const page = await backfillLegacyPage({
      db: this.db,
      run: this.options.run,
      selfRepo: this.options.selfRepo,
      current,
      now: this.now(),
      closed: () => this.closed,
      changed: this.options.changed,
      commitOf: (row) => this.mergeCommit(row),
      afterId: this.legacyCursor,
    });
    this.legacyCursor = page.more ? page.lastId : 0;
  }

  /**
   * 按仓库拉一次标签，找含合入提交的最早版本；还没有的看发版工作流（t265）：
   * 失败或合入很久没跑起来立刻记上线失败，超时没发版同样记一次。
   */
  private async findReleases(rows: TaskRow[]) {
    const fetched = new Map<string, boolean>();
    const runs = new ReleaseRuns(this.options.run);
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
      const mergedAt = this.mergedAt(row.id);
      if (mergedAt === null) continue;
      const verdict = commit
        ? await this.watchRelease(row, commit, mergedAt, runs)
        : null;
      this.overdue(row, mergedAt, verdict);
    }
  }

  /** 合入时刻（最近一次 merged 事件）；没有为 null。 */
  private mergedAt(id: number) {
    const merged = this.db
      .prepare(
        "SELECT at FROM task_events WHERE task_id=? AND kind='merged' ORDER BY id DESC LIMIT 1",
      )
      .get(id) as { at: number } | undefined;
    return merged?.at ?? null;
  }

  /** 看含它的发版跑到哪了；失败或没跑起来就记上线失败并投给负责人（紧急的另叫醒秘书）。 */
  private async watchRelease(
    row: TaskRow,
    commit: string,
    mergedAt: number,
    runs: ReleaseRuns,
  ): Promise<ReleaseVerdict | null> {
    // 已记过的不再查：发版修好后含它的新版本照样由标签认出来。
    if (row.release_failed_at != null || !row.repo) return null;
    const listed = await runs.list(row.repo);
    if (!listed || this.closed) return null;
    const verdict = releaseVerdict({
      runs: listed.runs,
      commit,
      mergedAt,
      now: this.now(),
    });
    if (verdict.kind !== "failed" && verdict.kind !== "missing") return verdict;
    const failure =
      verdict.kind === "failed"
        ? await runs.failure(listed.flag, verdict.run.id)
        : { step: null, tests: [], log: "" };
    if (this.closed) return verdict;
    const { reason, short } = releaseFailure({
      verdict,
      step: failure.step,
      tests: failure.tests,
    });
    const url = verdict.kind === "failed" ? verdict.run.url : null;
    const detail = {
      reason: url ? `${reason}；日志 ${url}` : reason,
      short,
      ...(url ? { run_url: url } : {}),
      ...(failure.step ? { step: failure.step } : {}),
      ...(failure.tests.length ? { failed_tests: failure.tests } : {}),
      ...(failure.log ? { log: failure.log } : {}),
    };
    if (
      markReleaseFailed(this.db, row.id, "release_failed", detail, this.now())
    ) {
      this.options.changed(row.id);
      this.options.publish(row.id, "release_failed", detail);
    }
    return verdict;
  }

  private async mergeCommit(row: {
    id: number;
    repo: string | null;
    pr_url: string | null;
  }) {
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

  /** 合入太久没出版本：同样按上线失败记一次（已因发版失败记过的不重复）。 */
  private overdue(
    row: TaskRow,
    mergedAt: number,
    verdict: ReleaseVerdict | null,
  ) {
    if (
      row.release_failed_at != null ||
      this.now() - mergedAt < RELEASE_OVERDUE_MS
    )
      return;
    // 升级前已提醒过的老任务：只补上标记，不再提醒。
    const told = this.db
      .prepare(
        "SELECT 1 FROM task_events WHERE task_id=? AND kind='release_overdue' AND id>(SELECT MAX(id) FROM task_events WHERE task_id=? AND kind='merged') LIMIT 1",
      )
      .get(row.id, row.id);
    if (told) {
      this.db
        .prepare(
          "UPDATE tasks SET release_failed_at=? WHERE id=? AND release_failed_at IS NULL",
        )
        .run(this.now(), row.id);
      return;
    }
    const { reason, short } = overdueFailure(
      Math.round(RELEASE_OVERDUE_MS / 60_000),
      verdict,
    );
    const detail = { reason, short };
    if (
      markReleaseFailed(this.db, row.id, "release_overdue", detail, this.now())
    ) {
      this.options.changed(row.id);
      this.options.publish(row.id, "release_overdue", detail);
    }
  }

  private async prepareOnline(id: number, current: string) {
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
    return {
      message,
      version: current,
      release: task.release_version,
      /** 原样的验证步骤；没写为 null（不随通知发出）。 */
      steps: verification,
      verification:
        verification ?? "执行者没有写「端到端验证」一节；请按任务目标自行验证",
    };
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
  const cli = async (args: string[], timeout: number) => {
    const { error, stdout, stderr } = await runFile(
      process.execPath,
      [bin, ...args],
      {
        cwd: data,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...env, ATRIUM_DATA: data },
      },
    );
    return {
      ok: !error,
      output: [stdout, stderr, error?.message]
        .filter(Boolean)
        .join("\n")
        .trim(),
    };
  };
  return async (version: string): Promise<DeployResult> => {
    const update = await cli(["update", "--to", version], 10 * 60_000);
    if (!update.ok)
      return {
        ok: false,
        reason: `atrium update：${redact(update.output) || "执行失败"}`,
      };
    const restart = await cli(["restart"], 60_000);
    if (!restart.ok)
      return {
        ok: false,
        reason: `atrium restart：${redact(restart.output) || "执行失败"}`,
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
