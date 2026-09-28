/**
 * 合入队列的提前检查（t254）：检查并行、合入串行。纯函数，穷举测试；执行在 merge-precheck.ts。
 *
 * 队首之后的几件先在各自 rebase 到当时 main 的提交上跑检查，记下「检查基于哪个 main 提交」（base）。
 * 轮到它合入时 main 若只前进了与它不相干的提交（不改同一批文件、不改依赖与检查配置），
 * 就用这次检查的结果按检查过的提交合入；否则照常 rebase 到最新 main 再跑一遍。
 * 合入仍一件一件来，`--match-head-commit` 仍是检查过的那个提交。
 */

import type { CheckClass } from "./check-outcome.ts";

/** 提前检查缺省最多几件（任务要求 2–3）。 */
export const MAX_PRECHECKS = 3;

/**
 * 同时提前检查几件：本机检查并发名额留一个给队首，其余给提前检查，至多 MAX_PRECHECKS。
 * ATRIUM_MERGE_PRECHECKS 显式给数（0 或 off 关掉）；写错按缺省并给 problem。
 * 测试进程（NODE_TEST_CONTEXT）没显式设置时关掉，免得无关用例多跑检查。
 */
export function precheckSlots(input: {
  maxChecks: number;
  env: NodeJS.ProcessEnv;
}): { slots: number; problem: string | null } {
  const fallback = input.env.NODE_TEST_CONTEXT
    ? 0
    : Math.min(MAX_PRECHECKS, Math.max(0, Math.floor(input.maxChecks) - 1));
  const raw = input.env.ATRIUM_MERGE_PRECHECKS?.trim().toLowerCase();
  if (raw === undefined || raw === "")
    return { slots: fallback, problem: null };
  if (raw === "off" || raw === "0") return { slots: 0, problem: null };
  if (/^[1-9][0-9]?$/.test(raw)) return { slots: Number(raw), problem: null };
  return {
    slots: fallback,
    problem: `ATRIUM_MERGE_PRECHECKS=${input.env.ATRIUM_MERGE_PRECHECKS} 看不懂，按缺省 ${fallback} 执行`,
  };
}

export type PrecheckCandidate = {
  id: number;
  /** 在本机的工作树（远程任务的工作树不在本机，合入时才建副本，不提前检查）。 */
  local: boolean;
  /** 这次排队以来已经提前检查过（不论结果）。 */
  done: boolean;
  /** 正在提前检查。 */
  running: boolean;
};

/**
 * 这一轮再开哪几件的提前检查。queued 是队首之后按合入先后排好的排队件（不含正在合入的），只看前 slots 件；
 * running 是此刻在跑的提前检查总数（含窗口外的、队首接手在等的），同时在跑的不超过 slots。
 * paused（紧急任务在合入流程里、检查没跑成正在等重跑）时不开新的。
 */
export function pickPrechecks(input: {
  queued: readonly PrecheckCandidate[];
  slots: number;
  running: number;
  paused: boolean;
}): number[] {
  if (input.paused || input.slots <= 0) return [];
  let free = input.slots - input.running;
  const picked: number[] = [];
  for (const candidate of input.queued.slice(0, input.slots)) {
    if (free <= 0) break;
    if (!candidate.local || candidate.done || candidate.running) continue;
    picked.push(candidate.id);
    free--;
  }
  return picked;
}

/** 提前检查的记录：检查的是哪个提交、基于哪个 main 提交、结果。 */
export type Precheck = { head: string; base: string; outcome: CheckClass };

export type ReuseInput = {
  /** 这次排队以来最近一次提前检查；没有为 null。 */
  precheck: Precheck | null;
  /** 任务工作树此刻的提交。 */
  head: string;
  /** 刚取到的 origin/<基础分支>。 */
  main: string;
  /** precheck.base 是不是 main 的祖先（main 被改写过就不是）。 */
  ancestor: boolean;
  /** precheck.base..head 改了哪些文件；取不到为 null。 */
  taskFiles: readonly string[] | null;
  /** precheck.base..main 改了哪些文件；取不到为 null。 */
  mainFiles: readonly string[] | null;
};

export type ReuseDecision =
  /** 用提前检查的结果按检查过的提交合入。 */
  | { kind: "reuse"; reason: string }
  /** 提前检查没过、main 也没动：结果就是这次的结果，直接交回。 */
  | { kind: "hand_back"; reason: string }
  /** 照常 rebase 到最新 main 再跑检查。 */
  | { kind: "recheck"; reason: string };

/** main 改了这些，不相干的改动也可能让检查结果变：依赖、编译配置、检查脚本本身。 */
const GLOBAL_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lockb",
  ".npmrc",
  ".nvmrc",
  ".node-version",
]);
const GLOBAL_PATHS = new Set([
  ".agents/check",
  ".agents/check-platform",
  ".agents/timing-sensitive",
]);

/** 这个文件改了会不会影响整个仓库的检查结果。 */
export function globalFile(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const name = normalized.split("/").at(-1) ?? normalized;
  return (
    GLOBAL_NAMES.has(name) ||
    GLOBAL_PATHS.has(normalized) ||
    /^tsconfig(\..+)?\.json$/.test(name)
  );
}

const listed = (files: readonly string[]) =>
  `${files.slice(0, 5).join("、")}${files.length > 5 ? ` 等 ${files.length} 个` : ""}`;

/** 轮到它合入时，提前检查的结果还能不能用。 */
export function reuseDecision(input: ReuseInput): ReuseDecision {
  const { precheck } = input;
  if (!precheck) return { kind: "recheck", reason: "没有提前检查" };
  if (precheck.head !== input.head)
    return { kind: "recheck", reason: "提前检查之后工作树的提交变了" };
  if (precheck.outcome === "not_run")
    return { kind: "recheck", reason: "提前检查没跑成" };
  const unchanged = precheck.base === input.main;
  if (precheck.outcome === "failed")
    return unchanged
      ? { kind: "hand_back", reason: "提前检查没过，main 之后没动" }
      : { kind: "recheck", reason: "提前检查没过，main 前进了，重跑确认" };
  if (unchanged) return { kind: "reuse", reason: "main 在提前检查之后没动" };
  if (!input.ancestor)
    return {
      kind: "recheck",
      reason: "main 被改写，提前检查的基础不在 main 上",
    };
  if (!input.taskFiles || !input.mainFiles)
    return { kind: "recheck", reason: "取不到改动文件，不能判断" };
  const global = input.mainFiles.filter(globalFile);
  if (global.length)
    return {
      kind: "recheck",
      reason: `main 改了依赖或检查配置：${listed(global)}`,
    };
  const mine = new Set(input.taskFiles);
  const shared = input.mainFiles.filter((file) => mine.has(file));
  if (shared.length)
    return {
      kind: "recheck",
      reason: `main 改了同一批文件：${listed(shared)}`,
    };
  return {
    kind: "reuse",
    reason: `main 之后只前进了不相干的改动（${input.mainFiles.length} 个文件）`,
  };
}
