import { ADAPTERS, type Tool } from "./adapters/index.ts";
import { overReserve } from "./budget.ts";
import { FALLBACK_ORDER, spareByProvider, type PaceEntry } from "./prepare.ts";
import { RISKS, type ProfileRules, type Risk, type Trust } from "./profiles.ts";
import { clock } from "./quota-holds.ts";
import { avoidReason, type ChainNode } from "../skills/model.ts";
import type { Headroom } from "./usage-budget.ts";

/**
 * 派活候选一览（task pick）：把候选执行者、账号额度、干活的专员与交付记录放在一张表里，
 * 给出推荐和理由；`task run` 自动挑人按同一份排序，写死执行者时据此提醒更富余的候选。
 * 纯函数：事实由 pick-runtime.ts 收集。
 */

/** 写死执行者时，另有能接的候选富余多出这么多个百分点就提醒。 */
export const NOTICE_SPARE_GAP = 30;

export type PickRecord = {
  deliveries: number;
  first_pass_rate: number | null;
  low_data: boolean;
};

export type PickCandidateFact = {
  /** 解析后的执行者标识（工具+模型[:强度]）。 */
  worker: string;
  tool: Tool;
  installed: boolean;
  rules: ProfileRules;
  /** 在干活的专员的候选顺序里排第几（0 起）；不是专员候选为 null。 */
  preferred: number | null;
};

export type PickFacts = {
  risk: Risk;
  /** 干活的专员（任务的 job）；没有为 null。 */
  job: { ref: string; name: string } | null;
  /** 专员候选（按专员顺序）在前，其余是各已装工具的默认执行者；同一执行者只出现一次。 */
  candidates: readonly PickCandidateFact[];
  /** OpenQuota 数据；读不到为 undefined，此时按固定顺序。 */
  pace?: readonly PaceEntry[];
  held: ReadonlyMap<string, number>;
  reservePercent: number;
  headroom: ReadonlyMap<string, Headroom>;
  busy: ReadonlySet<Tool>;
  chain: readonly ChainNode[];
  records: ReadonlyMap<string, PickRecord>;
};

export type PickAccount = {
  account: string;
  used_percent: number | null;
  spare_percent: number | null;
  hours_to_reset: number | null;
  /** 扣掉根章程保留份额（及节点份额）后还能用的百分点；没有数据为 null。 */
  left_percent: number | null;
  left_reason: string | null;
  /** 额度用尽标记的到期时刻；没有标记为 null。 */
  held_until: number | null;
};

export type PickCandidate = {
  worker: string;
  tool: Tool;
  /** 专员候选顺序（1 起）；不是专员候选为 null。 */
  preferred: number | null;
  trust: Trust;
  max_risk: Risk | null;
  eligible: boolean;
  /** 不能接的原因；能接为空。 */
  refusals: string[];
  /** 能接但值得知道的事（trust 低于 medium 合入前另派审阅等）。 */
  notes: string[];
  /** 独占工具且已有任务在跑：派了会排队。 */
  busy: boolean;
  /** 能接的候选里排第几（1 起）；不能接为 null。 */
  rank: number | null;
  quota: PickAccount;
  record: PickRecord | null;
};

export type PickView = {
  risk: Risk;
  job: { ref: string; name: string } | null;
  reserve_percent: number;
  /** OpenQuota 数据是否可用。 */
  quota_known: boolean;
  /** 能接的按推荐顺序在前，不能接的随后（保持收集顺序）。 */
  candidates: PickCandidate[];
  recommended: string | null;
  reason: string;
};

/** task run 回执里的挑人说明：自动挑时给理由，写死时给可能的提醒。 */
export type RunPick = {
  worker: string;
  auto: boolean;
  reason: string | null;
  notice: string | null;
};

/** 富余百分比写成 +54% / −13%。 */
export function signedPercent(value: number): string {
  const n = Math.round(value);
  return n > 0 ? `+${n}%` : n < 0 ? `−${-n}%` : "0%";
}

/** 一个账号的额度：多个窗口时已用取最大、富余取最小，距重置取最紧窗口的。 */
export function accountOf(
  account: string,
  facts: Pick<PickFacts, "pace" | "held" | "headroom">,
): PickAccount {
  const rows = facts.pace?.filter((entry) => entry.providerId === account);
  const spare = facts.pace ? spareByProvider(rows ?? []).get(account) : null;
  const used = (rows ?? [])
    .map((entry) => entry.usedPercent)
    .filter((n): n is number => typeof n === "number");
  const tight = (rows ?? [])
    .filter((entry) => entry.sparePercent !== null)
    .sort((a, b) => a.sparePercent! - b.sparePercent!)[0];
  const hours =
    tight?.hoursToReset ??
    (rows ?? [])
      .map((entry) => entry.hoursToReset)
      .filter((n): n is number => typeof n === "number")
      .sort((a, b) => a - b)[0];
  const room = facts.headroom.get(account);
  return {
    account,
    used_percent: used.length ? Math.max(...used) : null,
    spare_percent: spare ?? null,
    hours_to_reset: hours ?? null,
    left_percent: room ? Number(room.points.toFixed(2)) : null,
    left_reason: room?.reason ?? null,
    held_until: facts.held.get(account) ?? null,
  };
}

/** 一位候选不能接的原因（全部列出）；与 prepare.ts pickWorker、worker-choice.ts 的判定一致。 */
export function refusalsOf(
  candidate: PickCandidateFact,
  facts: PickFacts,
): string[] {
  const { rules, tool } = candidate;
  const account = ADAPTERS[tool].quotaProvider;
  const reasons: string[] = [];
  if (!candidate.installed)
    reasons.push(`没装：PATH 上找不到 ${ADAPTERS[tool].executable}`);
  const max = rules.max_risk;
  if (max && RISKS.indexOf(max) < RISKS.indexOf(facts.risk))
    reasons.push(`档案 max_risk=${max}，低于任务 risk=${facts.risk}`);
  if (
    facts.job &&
    Array.isArray(rules.avoid_jobs) &&
    rules.avoid_jobs.includes(facts.job.ref)
  )
    reasons.push(`档案 avoid_jobs 避开专员 ${facts.job.name}`);
  const avoided =
    facts.chain.length && avoidReason([...facts.chain], rules.avoid_nodes);
  if (avoided) reasons.push(avoided);
  const heldUntil = facts.held.get(account);
  if (heldUntil !== undefined) reasons.push(`额度用尽至 ${clock(heldUntil)}`);
  const over = facts.pace
    ?.filter((entry) => entry.providerId === account)
    .find((entry) => overReserve(entry.usedPercent, facts.reservePercent));
  if (over)
    reasons.push(
      `已用额度 ${over.usedPercent}% 达到章程上限 ${100 - facts.reservePercent}%（须留 ${facts.reservePercent}% 给用户）`,
    );
  const room = facts.headroom.get(account);
  if (!over && facts.pace && room && room.points < 1) reasons.push(room.reason);
  if (rules.billing === "metered")
    reasons.push("档案 billing=metered，当前钱份额为 0 元");
  return reasons;
}

/** trust 低于 medium 的执行者交付后合入前另派审阅；只提示，不挡。 */
function notesOf(candidate: PickCandidateFact): string[] {
  const trust = candidate.rules.trust ?? "unknown";
  return trust === "unknown" || trust === "low"
    ? [`trust=${trust}，合入前另派审阅`]
    : [];
}

/**
 * 排序：专员候选里能接、不正忙的按专员顺序在前；其余能接的按账号富余从多到少（没有富余数据的在后、按固定顺序），
 * 正忙的独占工具排到最后（只剩它时仍推荐它，派了会排队）。与 task run 自动挑人一致。
 */
export function pickView(facts: PickFacts): PickView {
  const spare = facts.pace ? spareByProvider(facts.pace) : new Map();
  const rows = facts.candidates.map((candidate, index) => {
    const refusals = refusalsOf(candidate, facts);
    const busy =
      ADAPTERS[candidate.tool].exclusive && facts.busy.has(candidate.tool);
    return {
      candidate,
      index,
      refusals,
      busy,
      spare: spare.get(ADAPTERS[candidate.tool].quotaProvider) as
        number | undefined,
    };
  });
  const eligible = rows.filter((row) => !row.refusals.length);
  const favoured = eligible
    .filter((row) => row.candidate.preferred !== null && !row.busy)
    .sort((a, b) => a.candidate.preferred! - b.candidate.preferred!);
  const byOrder = (row: (typeof rows)[number]) =>
    FALLBACK_ORDER.indexOf(row.candidate.tool);
  const rest = eligible
    .filter((row) => !favoured.includes(row))
    .sort((a, b) => {
      if (a.busy !== b.busy) return a.busy ? 1 : -1;
      if (a.spare === undefined || b.spare === undefined)
        return a.spare === b.spare
          ? byOrder(a) - byOrder(b) || a.index - b.index
          : a.spare === undefined
            ? 1
            : -1;
      return b.spare - a.spare || byOrder(a) - byOrder(b) || a.index - b.index;
    });
  const ranked = [...favoured, ...rest];
  const refused = rows.filter((row) => row.refusals.length);
  const candidates: PickCandidate[] = [...ranked, ...refused].map((row) => ({
    worker: row.candidate.worker,
    tool: row.candidate.tool,
    preferred:
      row.candidate.preferred === null ? null : row.candidate.preferred + 1,
    trust: row.candidate.rules.trust ?? "unknown",
    max_risk: row.candidate.rules.max_risk ?? null,
    eligible: !row.refusals.length,
    refusals: row.refusals,
    notes: notesOf(row.candidate),
    busy: row.busy,
    rank: ranked.includes(row) ? ranked.indexOf(row) + 1 : null,
    quota: accountOf(ADAPTERS[row.candidate.tool].quotaProvider, facts),
    record: facts.records.get(row.candidate.worker) ?? null,
  }));
  const top = candidates[0]?.eligible ? candidates[0] : undefined;
  return {
    risk: facts.risk,
    job: facts.job,
    reserve_percent: facts.reservePercent,
    quota_known: !!facts.pace,
    candidates,
    recommended: top?.worker ?? null,
    reason: pickReason(candidates, facts),
  };
}

const spareText = (quota: PickAccount) =>
  quota.spare_percent === null
    ? `${quota.account} 没有富余数据`
    : `${quota.account} 富余 ${signedPercent(quota.spare_percent)}`;

/** 推荐理由一句话：为什么是它，再对照其他账号或不能接的专员候选。 */
export function pickReason(
  candidates: readonly PickCandidate[],
  facts: Pick<PickFacts, "job" | "pace">,
): string {
  const top = candidates[0]?.eligible ? candidates[0] : undefined;
  if (!top) {
    const why = candidates
      .slice(0, 3)
      .map((c) => `${c.worker}：${c.refusals[0]}`)
      .join("；");
    return candidates.length
      ? `没有能接的执行者（${why}）`
      : "没有候选执行者：已装的编码 CLI 一个都没有";
  }
  const why: string[] = [];
  if (facts.job && top.preferred !== null)
    why.push(`${facts.job.name}专员优先`);
  else if (facts.job)
    why.push(
      candidates.some((c) => c.preferred !== null)
        ? `${facts.job.name}专员的优先执行者都不能接或正忙，按额度挑`
        : `${facts.job.name}专员没指定优先执行者，按额度挑`,
    );
  why.push(facts.pace ? spareText(top.quota) : "额度数据不可用，按固定顺序");
  if (top.busy) why.push(`${top.tool} 正忙，派了会排队`);
  const others: string[] = [];
  const seen = new Set([top.quota.account]);
  for (const c of candidates) {
    if (others.length >= 3) break;
    if (!c.eligible && c.preferred !== null) {
      others.push(`${c.worker} 不能接：${c.refusals[0]}`);
      seen.add(c.quota.account);
      continue;
    }
    // 其余只对照有富余数据的账号（没装、没数据的看表格）。
    if (
      seen.has(c.quota.account) ||
      !facts.pace ||
      c.quota.spare_percent === null
    )
      continue;
    seen.add(c.quota.account);
    others.push(
      c.eligible ? spareText(c.quota) : `${c.worker} 不能接：${c.refusals[0]}`,
    );
  }
  return `${why.join("、")}${others.length ? `；${others.join("；")}` : ""}`;
}

/**
 * 写死执行者时的提醒：另有能接、不正忙的候选，账号富余比写死的多至少 30 个百分点。
 * 写死的账号或对照账号没有富余数据时不提醒。
 */
export function writtenNotice(
  view: PickView,
  written: { worker: string; tool: Tool },
  taskRef: string,
): string | null {
  const account = ADAPTERS[written.tool].quotaProvider;
  const own = view.candidates.find((c) => c.quota.account === account)?.quota;
  const mine = own?.spare_percent;
  if (mine === null || mine === undefined) return null;
  const better = view.candidates
    .filter(
      (c) =>
        c.eligible &&
        !c.busy &&
        c.quota.account !== account &&
        c.quota.spare_percent !== null,
    )
    .sort((a, b) => b.quota.spare_percent! - a.quota.spare_percent!)[0];
  if (!better) return null;
  const gap = Math.round(better.quota.spare_percent! - mine);
  if (gap < NOTICE_SPARE_GAP) return null;
  return `提醒：${better.worker} 同样能接，${better.quota.account} 富余 ${signedPercent(better.quota.spare_percent!)}，比 ${written.worker} 的 ${account}（${signedPercent(mine)}）多 ${gap} 个百分点；看候选：atrium task pick ${taskRef}`;
}
