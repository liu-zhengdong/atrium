/**
 * 达成判定的纯判定（#313 第 2 步）：哪条验收标准是命令、每条的最新判定、能否提示「可标达成」、
 * 谁能人工判、输出摘要怎么截与抹凭据。不读库、不拉进程，穷举测试。
 *
 * 约定写法：以 `$ ` 开头的条目是命令，由运行时在里程碑的仓库（隔离的临时 worktree）里执行，
 * 退出码 0 为满足；其余条目由秘书或质量专员用 `goal check --item N --pass|--fail --note 证据` 判。
 */
import { leadsNode, prerequisiteMet, type GoalStatus } from "./rules.ts";

export const COMMAND_PREFIX = "$ ";
export const CHECK_RESULTS = [
  "running",
  "pass",
  "fail",
  "timeout",
  "error",
] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];
export const CHECK_LABEL: Record<CheckResult, string> = {
  running: "执行中",
  pass: "满足",
  fail: "不满足",
  timeout: "超时",
  error: "没跑成",
};

/** 条目是命令就返回命令正文（去掉 `$ `），否则 null。 */
export function commandOf(criterion: string): string | null {
  if (!criterion.startsWith(COMMAND_PREFIX)) return null;
  const command = criterion.slice(COMMAND_PREFIX.length).trim();
  return command || null;
}

/** 写验收标准时的额外校验：`$` 开头却没有命令，多半是笔误。 */
export function criterionProblem(criterion: string): string | null {
  if (/^\$\s*$/.test(criterion))
    return "以 $ 开头的条目要跟命令，如 $ npm test";
  if (/^\$\S/.test(criterion))
    return "命令条目写成 `$ 命令`（$ 后空一格），否则按人工判定的条目处理";
  return null;
}

export type CheckRecord = {
  id: number;
  criterion: string;
  kind: "command" | "manual";
  result: CheckResult;
  exit_code: number | null;
  summary: string | null;
  note: string | null;
  actor: string;
  started_at: number;
  ended_at: number | null;
};

export type ItemState<T extends CheckRecord = CheckRecord> = {
  n: number;
  text: string;
  command: string | null;
  latest: T | null;
};

/**
 * 每条验收标准的最新判定：按条目原文匹配（改过措辞的条目旧判定作废，调顺序不作废），取 id 最大的一条。
 */
export function itemStates<T extends CheckRecord>(
  criteria: readonly string[],
  checks: readonly T[],
): ItemState<T>[] {
  const latest = new Map<string, T>();
  for (const check of checks) {
    const seen = latest.get(check.criterion);
    if (!seen || check.id > seen.id) latest.set(check.criterion, check);
  }
  return criteria.map((text, i) => ({
    n: i + 1,
    text,
    command: commandOf(text),
    latest: latest.get(text) ?? null,
  }));
}

export type Readiness = { ready: boolean; blockers: string[] };

/**
 * 能否提示「可标达成」（不自动标）：有验收标准、每条最新判定都是满足、前置都达成、自己还没达成或放弃。
 * 不满足时 blockers 逐条说明卡在哪。
 */
export function readiness(
  status: GoalStatus,
  items: readonly ItemState[],
  prerequisites: readonly { ref: string; status: GoalStatus }[],
): Readiness {
  if (status === "achieved" || status === "dropped")
    return { ready: false, blockers: [] };
  const blockers: string[] = [];
  if (!items.length) blockers.push("还没有验收标准");
  for (const item of items) {
    const result = item.latest?.result;
    if (result === "pass") continue;
    blockers.push(
      `第 ${item.n} 条${
        !result
          ? item.command
            ? "还没跑"
            : "还没判"
          : result === "running"
            ? "正在执行"
            : CHECK_LABEL[result]
      }`,
    );
  }
  for (const p of prerequisites)
    if (!prerequisiteMet(p.status)) blockers.push(`前置 ${p.ref} 未达成`);
  return { ready: blockers.length === 0, blockers };
}

export type JudgeOrg = {
  id: number;
  parent_id: number | null;
  leader: string | null;
  kind: string;
  archived_at?: number | null;
};

/**
 * 人工判定的权限：负责部门的 leader 或其上级 leader（秘书领根节点，总能判），
 * 或负责部门链上某节点下「关注点」节点（如 atrium/质量）的 leader——质量专员判本项目的里程碑。
 */
export function canJudge(
  org: readonly JudgeOrg[],
  goal: { node_id: number },
  actor: string,
): { ok: true } | { ok: false; reason: string } {
  if (leadsNode(org, goal.node_id, actor)) return { ok: true };
  const chain = new Set<number>();
  let current = org.find((n) => n.id === goal.node_id);
  while (current && !chain.has(current.id)) {
    chain.add(current.id);
    const parent = current.parent_id;
    current = org.find((n) => n.id === parent);
  }
  const concern = org.some(
    (n) =>
      n.kind === "concern" &&
      n.leader === actor &&
      !n.archived_at &&
      n.parent_id !== null &&
      chain.has(n.parent_id),
  );
  return concern
    ? { ok: true }
    : {
        ok: false,
        reason: `${actor} 不是负责部门 o${goal.node_id} 的 leader、上级 leader 或同项目关注点（如质量）的 leader`,
      };
}

/** 人工判定只给写不成命令的条目：命令条目的结论由运行时跑出来，不采信自述。 */
export function manualBlocker(item: ItemState | undefined): string | null {
  if (!item) return "没有这一条";
  if (item.command)
    return `第 ${item.n} 条是命令，由运行时执行判定；去掉 --pass/--fail 重跑`;
  return null;
}

/** 命令的结论：超时、起不来、退出码 0 为满足，其余不满足。 */
export function commandResult(input: {
  code: number | null;
  timedOut: boolean;
  error?: string;
}): Exclude<CheckResult, "running"> {
  if (input.timedOut) return "timeout";
  if (input.error) return "error";
  return input.code === 0 ? "pass" : "fail";
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,})/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})/g,
  /\b(sk-[A-Za-z0-9_-]{16,})/g,
  /\b(xox[abprs]-[A-Za-z0-9-]{10,})/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /(?<=\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi,
  /(?<=\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)[A-Z0-9_]*\s*[=:]\s*["']?)([^\s"']{6,})/g,
];

/** 抹掉输出里常见的凭据形态（令牌、密钥、Bearer、XXX_TOKEN=值）。 */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "***");
  return out;
}

export const SUMMARY_MAX = 1500;
/** 输出摘要：去颜色码、抹凭据，取末尾不超过 SUMMARY_MAX 字、最多 20 行。 */
export function summarize(output: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = redact(output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")).trim();
  const lines = plain.split("\n").slice(-20).join("\n");
  const chars = Array.from(lines);
  return chars.length > SUMMARY_MAX
    ? `…${chars.slice(-SUMMARY_MAX).join("")}`
    : lines;
}
