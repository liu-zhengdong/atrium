import { ADAPTERS, type Tool } from "../adapters/index.ts";
import { overReserve } from "../quota/budget.ts";
import { FALLBACK_ORDER, spareByProvider, type PaceEntry } from "./prepare.ts";
import {
  RISKS,
  TRUSTS,
  type ProfileRules,
  type Risk,
  type Trust,
} from "../workers/profiles.ts";
import { clock } from "../quota/quota-holds.ts";
import { avoidReason, type ChainNode } from "../../skills/model.ts";
import type { Headroom } from "../quota/usage-budget.ts";
import { signedPercent, staleLabel } from "../quota/percent.ts";

/**
 * 派活候选一览（task run --dry-run）：把候选执行者、账号额度、干活的专员与交付记录放在一张表里，
 * 给出推荐和理由；`task run` 自动挑人按同一份排序，写死执行者时据此提醒更富余的候选。
 * 纯函数：事实由 pick-runtime.ts 收集。
 */

/**
 * 另有能接的候选富余多出这么多个百分点：专员优先的执行者超速时改推荐它，写死执行者时提醒它。
 * 两处都经 richerAlternative 判定。
 */
export const NOTICE_SPARE_GAP = 30;

export type PickRecord = {
  deliveries: number;
  first_pass_rate: number | null;
  low_data: boolean;
  /** 交付耗时中位数（毫秒）；没有为 null。紧急任务挑人时看谁快（t215）。 */
  median_ms?: number | null;
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
  /** 扣掉给用户保留的额度后还能用的百分点；没有数据为 null。 */
  left_percent: number | null;
  left_reason: string | null;
  /** 额度用尽标记的到期时刻；没有标记为 null。 */
  held_until: number | null;
  /** 读数是旧数（超过 10 分钟没刷新）：不算富余，spare_percent 为 null。 */
  stale: boolean;
  /** 旧数是多少小时前刷新的；不是旧数或不知道为 null。 */
  refreshed_hours_ago: number | null;
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

export { signedPercent };

/** 一个账号的额度：多个窗口时已用取最大、富余取最小，距重置取最紧窗口的；旧数不给富余。 */
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
  const stale = (rows ?? []).filter((entry) => entry.stale);
  const ago = stale
    .map((entry) => entry.refreshedHoursAgo)
    .filter((n): n is number => typeof n === "number");
  return {
    account,
    used_percent: used.length ? Math.max(...used) : null,
    spare_percent: spare ?? null,
    hours_to_reset: hours ?? null,
    left_percent: room ? Number(room.points.toFixed(2)) : null,
    left_reason: room?.reason ?? null,
    held_until: facts.held.get(account) ?? null,
    stale: stale.length > 0,
    refreshed_hours_ago: ago.length ? Math.max(...ago) : null,
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
      `已用额度 ${over.usedPercent}% 达到上限 ${100 - facts.reservePercent}%（须留 ${facts.reservePercent}% 给用户）`,
    );
  const room = facts.headroom.get(account);
  if (!over && facts.pace && room && room.points < 1) reasons.push(room.reason);
  if (rules.billing === "metered")
    reasons.push("档案 billing=metered（按量计费），不派");
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
 * 排序：专员候选里能接、不正忙的按专员顺序在前；其余能接的按账号富余从多到少（没有富余数据的在后、按固定顺序），正忙的独占工具排到最后
 * （只剩它时仍推荐它，派了会排队）；专员第 1 选超速且 richerAlternative 找到更富余的，那一位提到最前。
 * 与 task run 自动挑人（含 --auto 自动派）一致。
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
  const ordered = [...favoured, ...rest];
  // 专员第 1 选超速（富余为负）、另有信任度够的候选富余多出 NOTICE_SPARE_GAP 以上：改推荐那一位。
  const first = favoured[0];
  const swap =
    first && first.spare !== undefined && first.spare < 0
      ? richerAlternative(
          ordered.map((row) => ({
            worker: row.candidate.worker,
            account: ADAPTERS[row.candidate.tool].quotaProvider,
            spare: row.spare ?? null,
            eligible: true,
            busy: row.busy,
            trust: row.candidate.rules.trust ?? "unknown",
          })),
          {
            account: ADAPTERS[first.candidate.tool].quotaProvider,
            spare: first.spare,
          },
          facts.risk,
        )
      : null;
  const ranked = swap
    ? [
        ordered.find((row) => row.candidate.worker === swap.worker)!,
        ...ordered.filter((row) => row.candidate.worker !== swap.worker),
      ]
    : ordered;
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
    reason: pickReason(
      candidates,
      facts,
      swap
        ? candidates.find((c) => c.worker === first!.candidate.worker)
        : undefined,
    ),
  };
}

/** richerAlternative 比较用的候选：PickCandidate 与排序中间结果都能转成它。 */
export type SpareRival = {
  worker: string;
  account: string;
  spare: number | null;
  eligible: boolean;
  busy: boolean;
  trust: Trust;
};

/** 信任度够：不用合入前另派审阅（至少 medium），也够接这个 risk。 */
export function trusted(trust: Trust, risk: Risk): boolean {
  const level = TRUSTS.indexOf(trust);
  return level >= TRUSTS.indexOf("medium") && level > RISKS.indexOf(risk);
}

/**
 * 比 own 账号富余多出至少 NOTICE_SPARE_GAP 个百分点、自身富余为正、能接、不正忙、信任度够的
 * 另一账号候选，按给定顺序取第一个；own 或对方没有富余数据不算。排序改推荐与写死提醒共用。
 */
export function richerAlternative(
  rivals: readonly SpareRival[],
  own: { account: string; spare: number | null | undefined },
  risk: Risk,
): (SpareRival & { spare: number; gap: number }) | null {
  if (own.spare === null || own.spare === undefined) return null;
  for (const rival of rivals) {
    if (
      !rival.eligible ||
      rival.busy ||
      rival.account === own.account ||
      rival.spare === null ||
      rival.spare <= 0 ||
      !trusted(rival.trust, risk)
    )
      continue;
    const gap = Math.round(rival.spare - own.spare);
    if (gap >= NOTICE_SPARE_GAP) return { ...rival, spare: rival.spare, gap };
  }
  return null;
}

const rivalOf = (c: PickCandidate): SpareRival => ({
  worker: c.worker,
  account: c.quota.account,
  spare: c.quota.spare_percent,
  eligible: c.eligible,
  busy: c.busy,
  trust: c.trust,
});

const spareText = (quota: PickAccount) =>
  quota.spare_percent !== null
    ? `${quota.account} 富余 ${signedPercent(quota.spare_percent)}`
    : quota.stale
      ? `${quota.account} ${staleLabel(quota.refreshed_hours_ago)}，不按它排富余`
      : `${quota.account} 没有富余数据`;

/**
 * 推荐理由一句话：为什么是它，再对照最多两个相关账号或不能接的专员候选。
 * overSpeed：专员第 1 选超速、改推荐了更富余的候选时，被换下的那位。
 */
export function pickReason(
  candidates: readonly PickCandidate[],
  facts: Pick<PickFacts, "job" | "pace">,
  overSpeed?: PickCandidate,
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
  if (overSpeed) {
    const job = facts.job ? `${facts.job.name}专员` : "专员";
    const to =
      top.preferred !== null
        ? `第 ${top.preferred} 选 ${top.worker}`
        : ` ${top.worker}`;
    return `${job}第 ${overSpeed.preferred} 选 ${overSpeed.worker} 超速（${overSpeed.quota.account} ${signedPercent(overSpeed.quota.spare_percent!)}），改用${to}（${top.quota.account} ${signedPercent(top.quota.spare_percent!)}）`;
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
  // 只对照两个：不能接的专员候选，或有富余数据的其他账号（其余看表格）。
  const others: string[] = [];
  const seen = new Set([top.quota.account]);
  for (const c of candidates) {
    if (others.length >= 2) break;
    if (!c.eligible && c.preferred !== null) {
      others.push(`${c.worker} 不能接：${c.refusals[0]}`);
      seen.add(c.quota.account);
      continue;
    }
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
 * 写死执行者时的提醒：写的不是推荐的那位，且另有能接、不正忙、信任度够的候选账号富余多出至少
 * NOTICE_SPARE_GAP 个百分点（与排序改推荐同一判定，按推荐顺序取第一个）。
 * 写的就是推荐的、写死的账号或对照账号没有富余数据时不提醒。
 */
export function writtenNotice(
  view: PickView,
  written: { worker: string; tool: Tool },
  taskRef: string,
): string | null {
  if (written.worker === view.recommended) return null;
  const account = ADAPTERS[written.tool].quotaProvider;
  const mine = view.candidates.find((c) => c.quota.account === account)?.quota
    .spare_percent;
  const better = richerAlternative(
    view.candidates.map(rivalOf),
    { account, spare: mine },
    view.risk,
  );
  if (!better) return null;
  return `提醒：${better.worker} 同样能接，${better.account} 富余 ${signedPercent(better.spare)}，比 ${written.worker} 的 ${account}（${signedPercent(mine!)}）多 ${better.gap} 个百分点；看候选：atrium task run ${taskRef} --dry-run`;
}
