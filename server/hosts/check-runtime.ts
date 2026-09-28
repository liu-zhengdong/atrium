import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { firstLine, type Exec } from "../tasks/git.ts";
import { parseRemote } from "../tasks/gh-repo.ts";
import {
  runLocalCheck,
  sharedLocalChecks,
  type LocalCheck,
  type LocalCheckQueue,
} from "../tasks/local-check.ts";
import { QuietWatch, type QuietEvent } from "../tasks/check-quiet-watch.ts";
import {
  checkBaseline,
  checkRefusal,
  chooseCheckHost,
  type CheckCandidate,
} from "./check-plan.ts";
import { MAX_BUNDLE_BYTES, type CheckSource } from "./protocol.ts";
import type { RemoteHosts } from "./remote.ts";
import { hostRef, remoteClone } from "./state.ts";

/**
 * 本地检查派到哪台跑（#358 第 2 步）：合入队列 rebase 后的检查用（交付关卡不再跑全量检查）。
 * 挑主机是 check-plan.ts 的纯函数；这里取候选、在本机工作树里取提交与 bundle、派给代理，
 * 那台没跑成（离线、超时、取不到提交）就换一台或回本机重跑。关卡怎么判不变，只是换地方跑命令。
 */

export type CheckRequest = {
  task: number;
  /** 本机的任务工作树（合入队列是 rebase 后的那份）。 */
  worktree: string;
  /** 服务这边的任务目录：检查日志写在这里（远程的续传回来也写这里）。 */
  taskDir: string;
  /** 基础分支：bundle 只带 origin/<base> 之后的提交；不知道时只在本机跑。 */
  base: string | null;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  urgent?: boolean;
  /** 任务写了避开的主机（t215），及上一轮在上面没跑成的主机（t204）：检查不派过去。 */
  avoid?: readonly number[];
  onStatus?: (status: "queued" | "started", log: string, host: string) => void;
  /** 某台没跑成、换地方重跑时。 */
  onMoved?: (from: string, reason: string) => void;
  /** 检查日志太久没新输出（提醒）或之后又有输出了（t260）：在哪台跑的。 */
  onQuiet?: (event: QuietEvent, host: string) => void;
  /** 多久看一次日志有没有新输出；测试缩短。 */
  quietPollMs?: number;
};

type Prepared =
  | { ok: true; source: Omit<CheckSource, "clone">; repo: string }
  | { ok: false; reason: string };

/** 一次检查最多换几台远程（之后回本机）。 */
const MAX_REMOTE_TRIES = 3;

export class CheckDispatch {
  constructor(
    private readonly deps: {
      remote: RemoteHosts;
      /** 各主机此刻的检查候选（本机在里面）。 */
      candidates: () => CheckCandidate[];
      run: Exec;
      queue?: LocalCheckQueue;
      /** 测试注入：本机怎么跑检查。 */
      runLocal?: typeof runLocalCheck;
    },
  ) {}

  async run(request: CheckRequest): Promise<LocalCheck> {
    const tried = new Set<number>(request.avoid);
    let prepared: Prepared | undefined;
    // 把关检查只派到与检查基准同平台的主机（t201）：缺省是本机的平台，仓库可另配。
    const platform = checkBaseline(
      readConfigured(request.worktree),
      this.deps.candidates().find((c) => c.kind === "local")?.platform ??
        process.platform,
    );
    for (let attempt = 0; attempt < MAX_REMOTE_TRIES; attempt++) {
      const candidates = this.deps.candidates();
      // 没有能接的远程主机时不碰 git：只有本机（或只有别的平台的主机）照旧在本机跑。
      if (
        !candidates.some(
          (c) =>
            c.kind === "remote" &&
            !tried.has(c.id) &&
            !checkRefusal(c, { repo: "*", urgent: false, platform }),
        )
      )
        break;
      prepared ??= await this.prepare(request);
      if (!prepared.ok) break;
      const choice = chooseCheckHost(
        candidates,
        {
          repo: prepared.repo,
          urgent: request.urgent ?? false,
          platform,
          avoid: request.avoid ?? [],
        },
        tried,
      );
      if (choice.kind === "local") break;
      const host = choice.host;
      tried.add(host);
      const site = (() => {
        try {
          return this.deps.remote.site(host);
        } catch {
          return null;
        }
      })();
      if (!site) continue;
      const ref = hostRef(host);
      const log = join(request.taskDir, "local-check.log");
      try {
        request.onStatus?.("started", log, ref);
      } catch {
        // 进度事件记不上不影响检查。
      }
      // 远程的日志续传到服务这边：提醒在这边盯（t260）；没输出到结束线由那台的代理结束检查。
      const watch = new QuietWatch({
        file: log,
        limits: {
          ...(this.deps.queue ?? sharedLocalChecks).quiet,
          stallMs: null,
        },
        pollMs: request.quietPollMs,
        onEvent: (event) => request.onQuiet?.(event, ref),
      });
      const checked = this.deps.remote.check(host, {
        task: request.task,
        urgent: request.urgent ?? false,
        logFile: log,
        source: {
          ...prepared.source,
          clone: remoteClone(site, prepared.source.url),
        },
        signal: request.signal,
      });
      await watch.start();
      const result = await checked.finally(() => watch.stop());
      if (request.signal?.aborted || !result.infra) return result;
      try {
        request.onMoved?.(ref, result.infra);
      } catch {
        // 同上。
      }
    }
    const localRef = hostRef(
      this.deps.candidates().find((c) => c.kind === "local")?.id ?? 1,
    );
    const result = await (this.deps.runLocal ?? runLocalCheck)({
      worktree: request.worktree,
      taskDir: request.taskDir,
      env: request.env,
      signal: request.signal,
      urgent: request.urgent,
      ...(this.deps.queue ? { queue: this.deps.queue } : {}),
      onStatus: (status, log) => request.onStatus?.(status, log, localRef),
      onQuiet: (event) => request.onQuiet?.(event, localRef),
      quietPollMs: request.quietPollMs,
    });
    return { ...result, host: localRef };
  }

  /** 在本机工作树里取要检查的提交：有没提交的改动只能在本机跑；没推送的提交打成 bundle 带过去。 */
  private async prepare(request: CheckRequest): Promise<Prepared> {
    const run = this.deps.run;
    const git = (args: string[], timeoutMs = 30_000) =>
      run("git", ["-C", request.worktree, ...args], { timeoutMs });
    if (!request.base) return { ok: false, reason: "不知道基础分支" };
    const dirty = await git(["--no-optional-locks", "status", "--porcelain"]);
    if (!dirty.ok) return { ok: false, reason: firstLine(dirty.stderr) };
    if (dirty.stdout.trim())
      return { ok: false, reason: "工作树有没提交的改动，只能在本机检查" };
    const head = await git(["rev-parse", "HEAD"]);
    const url = await git(["remote", "get-url", "origin"]);
    const base = await git([
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${request.base}^{commit}`,
    ]);
    if (!head.ok || !url.ok || !base.ok)
      return { ok: false, reason: "取不到提交、远端地址或基础分支" };
    const commit = head.stdout.trim();
    const baseCommit = base.stdout.trim();
    const parsed = parseRemote(url.stdout.trim());
    const repo = parsed ? `${parsed.owner}/${parsed.name}` : "?";
    const source: Omit<CheckSource, "clone"> = {
      url: url.stdout.trim(),
      commit,
      base: request.base,
    };
    const pushed = await git([
      "merge-base",
      "--is-ancestor",
      commit,
      baseCommit,
    ]);
    if (pushed.ok) return { ok: true, source, repo };
    const file = join(request.taskDir, `check-${process.pid}.bundle`);
    try {
      const bundled = await git(
        ["bundle", "create", file, "HEAD", `^${baseCommit}`],
        120_000,
      );
      if (!bundled.ok)
        return {
          ok: false,
          reason: `打包提交失败：${firstLine(bundled.stderr)}`,
        };
      if (statSync(file).size > MAX_BUNDLE_BYTES)
        return { ok: false, reason: "要带过去的提交太大，在本机检查" };
      return {
        ok: true,
        source: { ...source, bundle: readFileSync(file).toString("base64") },
        repo,
      };
    } catch (error) {
      return { ok: false, reason: String(error) };
    } finally {
      rmSync(file, { force: true });
    }
  }
}

/** 仓库配的检查基准平台（`.agents/check-platform`）；没有或读不了为 null。 */
function readConfigured(worktree: string) {
  try {
    return readFileSync(join(worktree, ".agents", "check-platform"), "utf8");
  } catch {
    return null;
  }
}
