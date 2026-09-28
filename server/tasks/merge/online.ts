import { compareSemver, parseSemver } from "../../releases.ts";
import { parseRemote, repoFlag } from "../gh-repo.ts";

/**
 * 自动上线的判定（#325 第 3 步）：合入后等发版，运行时对自身 update + restart，
 * 新服务起来后跑一遍只读冒烟，把「已上线」通知负责人。这里只放纯函数，IO 在 online-runtime.ts。
 */

/** 自升级的仓库：`github:owner/repo` 或远端地址 → `-R` 写法；解析不出返回 null（不自升级）。 */
export function selfRepoFlag(source: string): string | null {
  const text = source.trim();
  const remote = text.startsWith("github:")
    ? parseRemote(`https://github.com/${text.slice("github:".length)}.git`)
    : parseRemote(text);
  return remote ? repoFlag(remote) : null;
}

/**
 * 是否允许服务对自己 update + restart：`ATRIUM_SELF_UPDATE=0` 关、`=1` 开；
 * 缺省只在用默认数据目录的安装版（包目录不是 git 检出）上开：开发中的 worktree 服务、
 * 测试与隔离服务（另给 ATRIUM_DATA）都不去动全局安装。
 */
export function selfUpdateEnabled(
  setting: string | undefined,
  service: { gitCheckout: boolean; defaultData: boolean },
): boolean {
  if (setting === "0") return false;
  if (setting === "1") return true;
  return !service.gitCheckout && service.defaultData;
}

/** `git tag --contains` 的输出 → 含该提交的最早版本（去掉 v）；没有返回 null。 */
export function firstRelease(tags: string): string | null {
  const versions = tags
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => {
      try {
        parseSemver(tag);
        return /^v/.test(tag);
      } catch {
        return false;
      }
    })
    .map((tag) => tag.slice(1))
    .sort(compareSemver);
  return versions[0] ?? null;
}

/** 只凭版本号大小不能证明提交在当前运行的版本分支里，须看当前版本的标签本身。 */
export function includedInVersion(tags: string, current: string): boolean {
  return tags.split("\n").some((tag) => tag.trim() === `v${current}`);
}

export type OnlineCandidate = {
  id: number;
  /** 含合入提交的最早版本；还没发版为 null。 */
  release: string | null;
  /** 已为哪个版本发起过自升级；没发起过为 null。 */
  attempted: string | null;
};

export type OnlinePlan = {
  /** 版本已在运行：标记已上线。 */
  online: number[];
  /** 已为覆盖它的版本自升级过、运行版本仍然更旧：上线失败。 */
  failed: number[];
  /** 需要自升级到的版本；null 表示这轮不升级。 */
  deploy: string | null;
  /** 这次升级覆盖的任务（发起前先记账）。 */
  deploying: number[];
  /** 不允许自升级（开发中的服务或显式关闭）：停在已合入。 */
  skipped: number[];
};

/**
 * 一轮上线判定：已发版且运行版本不旧于它的算上线；否则取最高版本自升级一次，
 * 升级过仍没到的判失败（不反复升级同一版本）；合入进行中时先不重启，避免打断本地检查。
 */
export function planOnline(
  candidates: OnlineCandidate[],
  current: string,
  options: { selfUpdate: boolean; busy: boolean },
): OnlinePlan {
  const plan: OnlinePlan = {
    online: [],
    failed: [],
    deploy: null,
    deploying: [],
    skipped: [],
  };
  const behind: OnlineCandidate[] = [];
  for (const task of candidates) {
    if (task.release === null) continue;
    if (compareSemver(task.release, current) <= 0) plan.online.push(task.id);
    else if (
      task.attempted !== null &&
      compareSemver(task.attempted, task.release) >= 0
    )
      plan.failed.push(task.id);
    else behind.push(task);
  }
  if (!behind.length) return plan;
  if (!options.selfUpdate) {
    plan.skipped = behind.map((task) => task.id);
    return plan;
  }
  if (options.busy) return plan;
  plan.deploy = behind
    .map((task) => task.release!)
    .sort(compareSemver)
    .at(-1)!;
  plan.deploying = behind.map((task) => task.id);
  return plan;
}

/** 已上线通知的人话：「tN 已上线（vX）」。 */
export function onlineMessage(ref: string, version: string) {
  return `${ref} 已上线（v${version}）`;
}
