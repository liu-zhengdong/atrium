import {
  appendFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { checkTreeName } from "../hosts/check-plan.ts";
import type { CheckReply, CheckSource } from "../hosts/protocol.ts";
import { firstLine, type Exec } from "../tasks/git.ts";
import { LocalCheckQueue, runLocalCheck } from "../tasks/local-check.ts";
import { ensureClone } from "./launch.ts";

/**
 * 代理按提交跑检查（#358 第 2 步）：在自己的克隆里 fetch 基础分支、装上服务带来的 bundle，
 * 把检查工作树（每个克隆几份，依赖装在里面下次沿用）切到这个提交，
 * 再用与本机同一份 runLocalCheck 跑（有 package-lock.json 且变了先 npm ci，tasks/install-deps.ts）。
 * 取不到提交、装不上依赖记为 infra（这台没跑成），服务换一台或回本机。
 */

/** 外层已按本机检查并发排过队：里面不再排。 */
const UNLIMITED = new LocalCheckQueue(1_000_000);

export type CommitCheck = {
  id: string;
  source: CheckSource;
  urgent: boolean;
  /** 这次检查的目录（日志、bundle 放这里）。 */
  dir: string;
  env: NodeJS.ProcessEnv;
  run: Exec;
  signal: AbortSignal;
  /** 同一克隆上的 git 操作排成一串（与派活的 fetch、建工作树不打架）。 */
  withClone: <T>(clone: string, work: () => Promise<T>) => Promise<T>;
  /** 占一个检查工作树号，用完还回来。 */
  slot: (clone: string) => { index: number; release: () => void };
  /** 这台主机上一次检查最多跑多久（ATRIUM_CHECK_TIMEOUT_MINUTES）。 */
  timeoutMs: number;
};

export async function checkCommit(input: CommitCheck): Promise<CheckReply> {
  const { source, dir, run } = input;
  const log = join(dir, "local-check.log");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(log, "", { mode: 0o600 });
  const note = (line: string) =>
    appendFileSync(log, `[atrium] ${line}\n`, { mode: 0o600 });
  const infra = (why: string): CheckReply => {
    note(why);
    return {
      status: "error",
      command: "",
      log,
      detail: why,
      failedTests: [],
      commit: source.commit,
      infra: why,
    };
  };
  const git = (args: string[], timeoutMs = 5 * 60_000) =>
    run("git", args, { timeoutMs });
  const ref = `refs/atrium/checks/${input.id.replace(/[^A-Za-z0-9-]/g, "")}`;
  note(`取提交 ${source.commit.slice(0, 12)}`);
  const fetched = await input.withClone(source.clone, async () => {
    try {
      await ensureClone(source.url, source.clone, run);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    const base = await git([
      "-C",
      source.clone,
      "fetch",
      "--quiet",
      "origin",
      source.base,
    ]);
    if (source.bundle) {
      const file = join(dir, "source.bundle");
      writeFileSync(file, Buffer.from(source.bundle, "base64"), {
        mode: 0o600,
      });
      const unbundled = await git([
        "-C",
        source.clone,
        "fetch",
        "--quiet",
        file,
        `+HEAD:${ref}`,
      ]);
      rmSync(file, { force: true });
      if (!unbundled.ok)
        return `装不上服务带来的提交：${firstLine(unbundled.stderr) || "git fetch 失败"}${base.ok ? "" : `（fetch ${source.base} 也失败：${firstLine(base.stderr)}）`}`;
    }
    const found = await git([
      "-C",
      source.clone,
      "cat-file",
      "-e",
      `${source.commit}^{commit}`,
    ]);
    if (!found.ok)
      return `这台取不到提交 ${source.commit.slice(0, 12)}${base.ok ? "" : `：fetch ${source.base} 失败（${firstLine(base.stderr)}）`}`;
    return null;
  });
  if (fetched) return infra(fetched);
  if (input.signal.aborted) return infra("服务不再等这次检查");
  const slot = input.slot(source.clone);
  const tree = checkTreeName(source.clone, slot.index);
  try {
    const placed = await input.withClone(source.clone, () =>
      placeTree(source.clone, tree, source.commit, git),
    );
    if (placed) return infra(placed);
    if (input.signal.aborted) return infra("服务不再等这次检查");
    note(`在 ${tree} 跑检查`);
    const result = await runLocalCheck({
      worktree: tree,
      taskDir: dir,
      env: input.env,
      urgent: input.urgent,
      queue: UNLIMITED,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      append: true,
      install: true,
    });
    return { ...result, commit: source.commit };
  } finally {
    slot.release();
    if (source.bundle)
      await git(["-C", source.clone, "update-ref", "-d", ref]).catch(
        () => undefined,
      );
  }
}

/** 检查工作树切到这个提交；已有的沿用（清掉上次的产物，依赖目录留着），坏了就重建。 */
async function placeTree(
  clone: string,
  tree: string,
  commit: string,
  git: (args: string[], timeoutMs?: number) => ReturnType<Exec>,
): Promise<string | null> {
  if (existsSync(join(tree, ".git"))) {
    const moved = await git([
      "-C",
      tree,
      "checkout",
      "--quiet",
      "--detach",
      "--force",
      commit,
    ]);
    if (moved.ok) {
      const cleaned = await git([
        "-C",
        tree,
        "clean",
        "-ffdxq",
        "-e",
        "node_modules",
      ]);
      if (cleaned.ok) return null;
    }
  }
  rmSync(tree, { recursive: true, force: true, maxRetries: 5 });
  await git(["-C", clone, "worktree", "prune"]);
  const added = await git([
    "-C",
    clone,
    "worktree",
    "add",
    "--quiet",
    "--detach",
    "--force",
    tree,
    commit,
  ]);
  return added.ok
    ? null
    : `建检查工作树失败：${firstLine(added.stderr) || "git worktree add 失败"}`;
}
