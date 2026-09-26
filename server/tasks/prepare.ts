import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { ADAPTERS, invalid, type Tool } from "./adapters/index.ts";
import { RISKS, type EffectiveProfile, type Risk } from "./profiles.ts";
import { parseOpenquotaRows, readOpenquotaPace } from "./openquota.ts";
import { clock } from "./quota-holds.ts";
import { DEFAULT_QUOTA_RESERVE_PERCENT, overReserve } from "./budget.ts";
import { idleFirst } from "./idle-first.ts";

/**
 * 派活准备（#262 B 部分）：拼提示词、读岗位说明、按额度挑执行者、规划 worktree。
 * 除 loadRoleDocs / readPace 只读文件或调用只读命令外都是纯函数；不建 worktree、不拉起进程。
 */

/** 派给任何执行者都附上的通用约束。 */
export const DEFAULT_RULES: readonly string[] = [
  "只在给定的工作目录（任务 worktree）内改动，不要切换到其他分支或目录干活。",
  "不要使用 git stash；未完成的改动提交到当前分支。",
  "做完后依次：运行项目检查、提交、推送、开 PR（正文写 Refs 对应 issue）、等 CI；任何一步做不了，写清楚卡在哪一步再结束。",
  "汇报里的 PR 号、提交号、CI 结果必须来自你刚执行过的命令输出；没做的步骤直接写「没做」。",
  "文档、提交说明和 PR 使用中文。",
];

export type PromptParts = {
  title: string;
  brief?: string;
  roleDoc?: string;
  rootDoc?: string;
  profileBody?: string;
  rules?: readonly string[];
};

/** 拼派活提示词：标题、详述、岗位说明、组织说明、执行者叮嘱、通用约束；空段省略。 */
export function buildPrompt({
  title,
  brief,
  roleDoc,
  rootDoc,
  profileBody,
  rules = DEFAULT_RULES,
}: PromptParts): string {
  const heading = title.trim();
  if (!heading) throw invalid("任务标题不能为空");
  const sections: [string, string | undefined][] = [
    ["任务详述", brief],
    ["岗位说明", roleDoc],
    ["组织说明（.agents/README.md）", rootDoc],
    ["给你的额外叮嘱", profileBody],
    ["通用约束", rules.map((rule) => `- ${rule}`).join("\n")],
  ];
  const parts = [`# 任务：${heading}`];
  for (const [name, text] of sections)
    if (text?.trim()) parts.push(`## ${name}\n\n${text.trim()}`);
  return `${parts.join("\n\n")}\n`;
}

export type RoleDocs = { roleDoc: string; rootDoc: string; rolePath?: string };

/** role 只能是 .agents/ 下的相对名：拒绝 `..`、绝对路径、隐藏段、空段和反斜杠。 */
export function checkRole(role: string): string[] {
  const text = role.trim();
  if (!text) throw invalid("role 不能为空");
  if (isAbsolute(text) || text.includes("\\") || text.includes("\0"))
    throw invalid(`role 不合法：${role}`);
  const segments = text.replace(/\.md$/, "").split("/");
  if (segments.some((seg) => !seg || seg === ".." || seg.startsWith(".")))
    throw invalid(`role 不合法：${role}`);
  return segments;
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

/** 解析符号链接后仍须落在 .agents/ 内，防止链接指向仓库外。 */
async function insideAgents(agentsDir: string, file: string) {
  try {
    const [root, real] = await Promise.all([
      realpath(agentsDir),
      realpath(file),
    ]);
    const rel = relative(root, real);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * 读岗位说明：role 为 `modules/web`、`concerns/安全` 时按原路径找；只写名字（`web`）时依次找
 * modules/ 与 concerns/。另读根 `.agents/README.md`。文件不存在返回空串。
 */
export async function loadRoleDocs(
  repo: string,
  role?: string,
): Promise<RoleDocs> {
  if (!isAbsolute(repo)) throw invalid("仓库须为绝对路径");
  const agentsDir = join(repo, ".agents");
  const rootDoc = (await readIfExists(join(agentsDir, "README.md"))) ?? "";
  if (role === undefined || role === null) return { roleDoc: "", rootDoc };
  const segments = checkRole(role);
  const name = segments.join("/");
  const candidates =
    segments.length === 1
      ? [`modules/${name}.md`, `concerns/${name}.md`]
      : [`${name}.md`];
  for (const rel of candidates) {
    const file = join(agentsDir, ...rel.split("/"));
    if (!(await insideAgents(agentsDir, file))) continue;
    const text = await readIfExists(file);
    if (text !== undefined)
      return { roleDoc: text, rootDoc, rolePath: `.agents/${rel}` };
  }
  return { roleDoc: "", rootDoc };
}

/** openquota pace --json 的一条记录；只取用到的字段。 */
export type PaceEntry = {
  providerId: string;
  sparePercent: number | null;
  usedPercent?: number | null;
  windowId?: string | null;
};

/** 调 `openquota pace --json`；没装、超时、输出不是预期 JSON 都返回 undefined。 */
export async function readPace(
  bin?: string,
  timeoutMs = 10_000,
): Promise<PaceEntry[] | undefined> {
  const result = await readOpenquotaPace({ bin, timeoutMs });
  return "ok" in result ? parsePaceRows(result.rows) : undefined;
}

export function parsePace(text: string): PaceEntry[] | undefined {
  const data = parseOpenquotaRows(text);
  return data ? parsePaceRows(data) : undefined;
}

function parsePaceRows(data: unknown[]): PaceEntry[] {
  const entries: PaceEntry[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const { providerId, sparePercent, usedPercent, windowId } = item as Record<
      string,
      unknown
    >;
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
    });
  }
  return entries;
}

/** 按账号汇总富余：同一 provider 多个窗口时取最小（最紧的那个窗口说了算）。 */
export function spareByProvider(
  pace: readonly PaceEntry[],
): Map<string, number> {
  const spare = new Map<string, number>();
  for (const { providerId, sparePercent } of pace) {
    if (sparePercent === null) continue;
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
  /** 已有任务在跑的工具：其中独占的排到空闲候选之后。 */
  busy?: ReadonlySet<Tool>;
  /** 这次不挑的工具（临时错误后换执行者时排除刚失败的那个）。 */
  exclude?: ReadonlySet<Tool>;
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
 * 挑执行者：跳过没装的、档案风险不允许的、额度标记未到期的、触及章程保留额的；pace 可用时按账号富余从多到少，
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
  busy,
  exclude,
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
        reason: `已用额度 ${used.usedPercent}% 达到章程上限 ${100 - reservePercent}%（须留 ${reservePercent}% 给用户）`,
      });
      continue;
    }
    eligible.push(tool);
  }
  if (!eligible.length)
    return {
      ok: false,
      reason:
        "没有可用的执行者：都没装、档案不允许该风险、额度用尽或触及章程保留额",
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

export const SLUG_MAX = 40;

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
  const base =
    repo.length > 1 ? repo.replace(new RegExp(`\\${sep}+$`), "") : repo;
  const slug = slugBase(title) || slugBase(role ?? "") || "task";
  return {
    path: `${base}-t${taskId}-${slug}`,
    branch: `task-t${taskId}-${slug}`,
    slug,
  };
}
