import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { trimTrailingSeparators } from "../../platform/plan.ts";
import { ADAPTERS, invalid, type Tool } from "../adapters/index.ts";
import {
  RISKS,
  type EffectiveProfile,
  type Risk,
} from "../workers/profiles.ts";
import { trustRefusal } from "./plan.ts";
import { parseOpenquotaRows } from "../quota/openquota.ts";
import {
  readQuotaRows,
  type QuotaSourceOptions,
} from "../quota/quota-source.ts";
import { hasQuotaData } from "../../quota-readers/merge.ts";
import { clock } from "../quota/quota-holds.ts";
import { DEFAULT_QUOTA_RESERVE_PERCENT, overReserve } from "../quota/budget.ts";
import { idleFirst } from "./idle-first.ts";
import { avoidReason, type ChainNode } from "../../skills/model.ts";

/**
 * 派活准备（#262 B 部分）：拼提示词、读岗位说明、按额度挑执行者、规划 worktree。
 * 除 loadRootDoc / readPace 只读文件或调用只读命令外都是纯函数；不建 worktree、不拉起进程。
 */

/** 派给任何执行者都附上的通用约束。 */
export const DEFAULT_RULES: readonly string[] = [
  "只在给定的工作目录（任务 worktree）内改动，不要切换到其他分支或目录干活。",
  "不要使用 git stash；未完成的改动提交到当前分支。",
  "做完后依次：提交、推送、开 PR（正文写 Refs 对应 issue）；任何一步做不了，写清楚卡在哪一步再结束。全量检查由运行时在任务 worktree 跑。",
  "汇报里的 PR 号、提交号、CI 结果必须来自你刚执行过的命令输出；没做的步骤直接写「没做」。",
  "文档、提交说明和 PR 使用中文。",
  "交付前做端到端验证：在隔离环境里（临时数据目录、另一个端口，如 `ATRIUM_PORT=<空闲端口> ATRIUM_DATA=<临时目录> node bin/atrium.mjs …`，用完同变量 stop）实跑一两条能证明这次改动生效的命令，把命令与输出原样贴进 PR 正文「## 端到端验证」一节；合入前的审阅会核对。不碰用户在用的服务、数据与电脑。",
  "PR 正文写「## 碰到哪些已有能力」一节：列出本次改动与哪些已有能力交叉（远程主机、Windows、总任务、技能挂载、合入队列、自升级……），各验了什么；没碰到写「无」。问题多出在新旧能力的组合上，写清楚好让试点挑对地方。",
  "每做一段较长的工作前，先用一句中文说明正在做什么（如「正在补单测」），看板会把这句显示为你的最近动作。",
  "gh 命令一律带 `-R <owner/repo>`（取自 origin 远端）：fork 仓库另有 upstream 时，不带 -R 会查到或开到上游；PR 开在 origin 上。",
];

export type PromptParts = {
  title: string;
  brief?: string;
  /** 之前运行中收到的捎话（tell.ts tellSection），紧跟任务详述。 */
  tells?: string;
  /** 本次注入的凭据名称与用法（secrets/model.ts secretSection），不含值。 */
  secrets?: string;
  /** 干活的专员（一句分工）或体验巡检的说明。 */
  role?: string;
  /** 归属部门链上的要点（map/context.ts taskContext）。 */
  points?: string;
  /** 本次挂载的组织技能（server/skills/mount.ts 生成）。 */
  skills?: string;
  rootDoc?: string;
  rules?: readonly string[];
};

/** 拼派活提示词：标题、详述、运行中收到的补充、可用的凭据（只有名称）、分工、规矩、挂载的技能、组织说明、通用约束；空段省略。 */
export function buildPrompt({
  title,
  brief,
  tells,
  secrets,
  role,
  points,
  skills,
  rootDoc,
  rules = DEFAULT_RULES,
}: PromptParts): string {
  const heading = title.trim();
  if (!heading) throw invalid("任务标题不能为空");
  const sections: [string, string | undefined][] = [
    ["任务详述", brief],
    ["运行中收到的补充", tells],
    ["可用的凭据", secrets],
    ["分工", role],
    ["规矩", points],
    ["本次挂载的技能", skills],
    ["组织说明（.agents/README.md）", rootDoc],
    ["通用约束", rules.map((rule) => `- ${rule}`).join("\n")],
  ];
  const parts = [`# 任务：${heading}`];
  for (const [name, text] of sections)
    if (text?.trim()) parts.push(`## ${name}\n\n${text.trim()}`);
  return `${parts.join("\n\n")}\n`;
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR")
      return undefined;
    throw error;
  }
}

/** 读仓库根的 `.agents/README.md`（跟着代码走的约定）；不存在返回空串。 */
export async function loadRootDoc(repo: string): Promise<string> {
  if (!isAbsolute(repo)) throw invalid("仓库须为绝对路径");
  return (await readIfExists(join(repo, ".agents", "README.md"))) ?? "";
}

/** 额度 pace 行（自带读取器或 openquota pace --json）；只取用到的字段。 */
export type PaceEntry = {
  providerId: string;
  sparePercent: number | null;
  usedPercent?: number | null;
  windowId?: string | null;
  hoursToReset?: number | null;
  /** 读数已过 OpenQuota 面板的 10 分钟阈值（自带读取器同一口径）：不算富余。 */
  stale?: boolean;
  /** 读数是多少小时前刷新的；只用来展示。 */
  refreshedHoursAgo?: number | null;
};

/**
 * 读各账号额度（quota-source：自带读取器优先，OpenQuota 补）；一个有数据的账号都没有时返回 undefined，
 * 挑执行者退回档案与运行时额度用尽标记。读不到的账号不进结果。
 */
export async function readPace(
  bin?: string,
  timeoutMs = 10_000,
  source: Omit<QuotaSourceOptions, "bin" | "timeoutMs"> = {},
): Promise<PaceEntry[] | undefined> {
  const { rows } = await readQuotaRows({ ...source, bin, timeoutMs });
  const entries = parsePaceRows(rows.filter(hasQuotaData));
  return entries.length ? entries : undefined;
}

export function parsePace(text: string): PaceEntry[] | undefined {
  const data = parseOpenquotaRows(text);
  return data ? parsePaceRows(data) : undefined;
}

function parsePaceRows(data: unknown[]): PaceEntry[] {
  const entries: PaceEntry[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const {
      providerId,
      sparePercent,
      usedPercent,
      windowId,
      hoursToReset,
      stale,
      refreshedHoursAgo,
    } = item as Record<string, unknown>;
    if (typeof providerId !== "string") continue;
    entries.push({
      providerId,
      sparePercent:
        typeof sparePercent === "number" && Number.isFinite(sparePercent)
          ? sparePercent
          : null,
      usedPercent:
        typeof usedPercent === "number" && Number.isFinite(usedPercent)
          ? usedPercent
          : null,
      windowId: typeof windowId === "string" ? windowId : null,
      ...(typeof hoursToReset === "number" &&
      Number.isFinite(hoursToReset) &&
      hoursToReset > 0
        ? { hoursToReset }
        : {}),
      ...(stale === true
        ? {
            stale: true,
            refreshedHoursAgo:
              typeof refreshedHoursAgo === "number" &&
              Number.isFinite(refreshedHoursAgo)
                ? refreshedHoursAgo
                : null,
          }
        : {}),
    });
  }
  return entries;
}

/**
 * 按账号汇总富余：同一 provider 多个窗口时取最小（最紧的那个窗口说了算）。
 * 旧数（stale）不算富余，也不拿它往后推算：那个账号当作没有富余数据，排序退回档案与固定顺序。
 */
export function spareByProvider(
  pace: readonly PaceEntry[],
): Map<string, number> {
  const spare = new Map<string, number>();
  for (const { providerId, sparePercent, stale } of pace) {
    if (sparePercent === null || stale) continue;
    const prev = spare.get(providerId);
    spare.set(
      providerId,
      prev === undefined ? sparePercent : Math.min(prev, sparePercent),
    );
  }
  return spare;
}

/** pace 不可用时的固定顺序。 */
export const FALLBACK_ORDER: readonly Tool[] = [
  "claude",
  "codex",
  "opencode",
  "grok",
  "kimi",
  "agy",
  "cursor",
];

export type PickInput = {
  /** 已装的工具（detectInstalled 的结果或工具名列表）。 */
  installed: Iterable<Tool> | Partial<Record<Tool, unknown>>;
  pace?: readonly PaceEntry[];
  risk: Risk;
  /** 各工具默认执行者的生效档案；缺档案视为不限制 risk。 */
  profiles: Partial<Record<Tool, EffectiveProfile>>;
  /** 额度被标记用尽、还没到期的账号：provider → 到期时刻（#267）。 */
  held?: ReadonlyMap<string, number>;
  reservePercent?: number;
  headroom?: ReadonlyMap<string, { points: number; reason: string }>;
  /** 已有任务在跑的工具：其中独占的排到空闲候选之后。 */
  busy?: ReadonlySet<Tool>;
  /** 这次不挑的工具（临时错误后换执行者时排除刚失败的那个）。 */
  exclude?: ReadonlySet<Tool>;
  /** 额度换人额外要求档案 trust 覆盖任务风险。 */
  requireTrust?: boolean;
  /** 任务所在节点链（根 → 本节点）：档案 avoid_nodes 命中的执行者不挑。 */
  chain?: readonly ChainNode[];
  jobRef?: string;
};

export type Skip = { tool: Tool; reason: string };
export type PickResult =
  | {
      ok: true;
      tool: Tool;
      spare?: number;
      basis: "pace" | "fallback";
      skipped: Skip[];
      available: Tool[];
    }
  | { ok: false; reason: string; skipped: Skip[] };

/**
 * 挑执行者：跳过没装的、档案风险不允许的、档案 avoid_nodes 避开任务节点的、额度标记未到期的、触及给用户的保留额的；pace 可用时按账号富余从多到少，
 * 没有富余数据的工具排在有数据的之后并按固定顺序；pace 不可用时整体按固定顺序。
 * 最后把正忙的独占工具挪到空闲候选之后（idle-first.ts）。
 */
export function pickWorker({
  installed,
  pace,
  risk,
  profiles,
  held,
  reservePercent = DEFAULT_QUOTA_RESERVE_PERCENT,
  headroom,
  busy,
  exclude,
  requireTrust,
  chain,
  jobRef,
}: PickInput): PickResult {
  if (!(RISKS as readonly string[]).includes(risk))
    throw invalid(`risk 只能是 ${RISKS.join("、")}`);
  const have = new Set<Tool>(
    Symbol.iterator in (installed as object)
      ? (installed as Iterable<Tool>)
      : (Object.keys(installed) as Tool[]).filter(
          (tool) => (installed as Record<string, unknown>)[tool],
        ),
  );
  const skipped: Skip[] = [];
  const eligible: Tool[] = [];
  for (const tool of FALLBACK_ORDER) {
    if (!have.has(tool)) {
      skipped.push({ tool, reason: "没装" });
      continue;
    }
    if (exclude?.has(tool)) {
      skipped.push({ tool, reason: "刚因临时错误失败，这次换别的" });
      continue;
    }
    const max = profiles[tool]?.rules.max_risk;
    if (max && RISKS.indexOf(max) < RISKS.indexOf(risk)) {
      skipped.push({
        tool,
        reason: `档案 max_risk=${max}，低于任务 risk=${risk}`,
      });
      continue;
    }
    const jobAvoid = profiles[tool]?.rules.avoid_jobs;
    if (jobRef && Array.isArray(jobAvoid) && jobAvoid.includes(jobRef)) {
      skipped.push({ tool, reason: `档案 avoid_jobs 避开专员 ${jobRef}` });
      continue;
    }
    const avoided =
      chain?.length && avoidReason(chain, profiles[tool]?.rules.avoid_nodes);
    if (avoided) {
      skipped.push({ tool, reason: avoided });
      continue;
    }
    const trust =
      requireTrust && trustRefusal(tool, profiles[tool]?.rules.trust, risk);
    if (trust) {
      skipped.push({ tool, reason: trust });
      continue;
    }
    const heldUntil = held?.get(ADAPTERS[tool].quotaProvider);
    if (heldUntil !== undefined) {
      skipped.push({ tool, reason: `额度用尽至 ${clock(heldUntil)}` });
      continue;
    }
    const used = pace
      ?.filter((entry) => entry.providerId === ADAPTERS[tool].quotaProvider)
      .find((entry) => overReserve(entry.usedPercent, reservePercent));
    if (used) {
      skipped.push({
        tool,
        reason: `已用额度 ${used.usedPercent}% 达到上限 ${100 - reservePercent}%（须留 ${reservePercent}% 给用户）`,
      });
      continue;
    }
    const room = headroom?.get(ADAPTERS[tool].quotaProvider);
    if (pace && room && room.points < 1) {
      skipped.push({ tool, reason: room.reason });
      continue;
    }
    if (profiles[tool]?.rules.billing === "metered") {
      skipped.push({ tool, reason: "档案 billing=metered（按量计费），不派" });
      continue;
    }
    eligible.push(tool);
  }
  if (!eligible.length)
    return {
      ok: false,
      reason:
        "没有可用的执行者：都没装、档案不允许该风险、额度用尽或触及给用户的保留额",
      skipped,
    };
  if (!pace) {
    const order = idleFirst(eligible, busy);
    return {
      ok: true,
      tool: order[0],
      basis: "fallback",
      skipped,
      available: order,
    };
  }
  const spare = spareByProvider(pace);
  const ranked = eligible
    .map((tool, order) => ({
      tool,
      order,
      spare: spare.get(ADAPTERS[tool].quotaProvider),
    }))
    .sort((a, b) =>
      a.spare === undefined || b.spare === undefined
        ? a.spare === b.spare
          ? a.order - b.order
          : a.spare === undefined
            ? 1
            : -1
        : b.spare - a.spare || a.order - b.order,
    );
  const order = idleFirst(
    ranked.map((entry) => entry.tool),
    busy,
  );
  const spareOf = spare.get(ADAPTERS[order[0]].quotaProvider);
  return {
    ok: true,
    tool: order[0],
    spare: spareOf,
    basis: spareOf === undefined ? "fallback" : "pace",
    skipped,
    available: order,
  };
}

const SLUG_MAX = 40;

/** 规范化成 slug，可能为空串（如纯中文标题）；只留小写字母、数字和连字符，截断到 40。 */
function slugBase(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

/** 标题转 slug：全被滤掉时用 task。 */
export function slugify(title: string): string {
  return slugBase(title) || "task";
}

export type WorktreePlan = { path: string; branch: string; slug: string };

/**
 * worktree 规划：路径 `<repo>-t<id>-<slug>`，分支 `task-t<id>-<slug>`。只算，不建。
 * slug 依次取标题、role：中文标题滤不出内容时用 role，都没有才退回 task。
 */
export function worktreePlan(
  repo: string,
  taskId: number,
  title: string,
  role?: string,
): WorktreePlan {
  if (!isAbsolute(repo)) throw invalid("仓库须为绝对路径");
  if (!Number.isSafeInteger(taskId) || taskId <= 0)
    throw invalid("任务编号不合法");
  const base = trimTrailingSeparators(process.platform, repo);
  const slug = slugBase(title) || slugBase(role ?? "") || "task";
  return {
    path: `${base}-t${taskId}-${slug}`,
    branch: `task-t${taskId}-${slug}`,
    slug,
  };
}
