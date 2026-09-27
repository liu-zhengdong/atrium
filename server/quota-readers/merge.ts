import { LAST_GOOD_MS, type ReaderOutcome } from "./index.ts";
import { paceRow } from "./pace.ts";

/**
 * 额度来源合并（纯函数，#352）：自带读取器优先；自带没覆盖、或自带这次读不到的账号，
 * 本机 OpenQuota 有就用它补；都没有的账号显示「读不到：原因」或「没有额度数据」。
 * 每行带 source（builtin / openquota / null）与 note（给人看的说明），其余字段与 pace 行一致。
 */

export type QuotaSource = "builtin" | "openquota";

export type SourcedRow = Record<string, unknown> & {
  providerId: string;
  source: QuotaSource | null;
  note: string | null;
  /** 自带读数来自哪台主机（hN，#358 第 2 步）；不知道主机时不给。 */
  from?: string | null;
  /** 这个账号对应的编码 CLI 能在哪几台主机用；不知道主机时不给。 */
  hosts?: string[];
};

export type HostReadings = {
  host: string;
  readings: readonly { provider: string; outcome: ReaderOutcome }[];
};

export type HostMerged = {
  outcome: ReaderOutcome;
  /** 读数来自哪台；都读不到为 null。 */
  from: string | null;
};

/**
 * 多台主机的自带读数按账号合并（#358 第 2 步）：同一账号指纹在几台都读到只算一份、取最新的；
 * 认不出账号的读数按主机各算各的。一个 provider 只出一行：本机登录的那个账号优先（本机派活最多），
 * 本机没读到就用最新的那份；别的主机登录的是另一个账号时在说明里写明没算进来。
 * 超过 LAST_GOOD_MS 的读数不用。
 */
export function mergeHostReadings(input: {
  local: string;
  localReadings: ReadonlyMap<string, ReaderOutcome>;
  reports: readonly HostReadings[];
  now: number;
}): Map<string, HostMerged> {
  type Good = Extract<ReaderOutcome, { ok: true }>;
  type Group = { outcome: Good; from: string; hosts: string[] };
  const providers = new Map<
    string,
    { groups: Map<string, Group>; failures: Map<string, string> }
  >();
  const add = (host: string, provider: string, outcome: ReaderOutcome) => {
    let entry = providers.get(provider);
    if (!entry) {
      entry = { groups: new Map(), failures: new Map() };
      providers.set(provider, entry);
    }
    if (!outcome.ok || input.now - outcome.result.refreshedAt > LAST_GOOD_MS) {
      if (!entry.failures.has(host))
        entry.failures.set(host, outcome.ok ? "读数太旧" : outcome.reason);
      return;
    }
    const key = outcome.result.account
      ? `a:${outcome.result.account}`
      : `h:${host}`;
    const group = entry.groups.get(key);
    if (!group) {
      entry.groups.set(key, { outcome, from: host, hosts: [host] });
      return;
    }
    group.hosts.push(host);
    if (outcome.result.refreshedAt > group.outcome.result.refreshedAt) {
      group.outcome = outcome;
      group.from = host;
    }
  };
  for (const [provider, outcome] of input.localReadings)
    add(input.local, provider, outcome);
  for (const report of input.reports) {
    if (report.host === input.local) continue;
    for (const reading of report.readings)
      add(report.host, reading.provider, reading.outcome);
  }
  const merged = new Map<string, HostMerged>();
  for (const [provider, { groups, failures }] of providers) {
    const list = [...groups.values()];
    if (!list.length) {
      const reason =
        failures.get(input.local) ?? failures.values().next().value ?? NO_DATA;
      merged.set(provider, { outcome: { ok: false, reason }, from: null });
      continue;
    }
    const pick =
      list.find((group) => group.hosts.includes(input.local)) ??
      list.reduce((a, b) =>
        b.outcome.result.refreshedAt > a.outcome.result.refreshedAt ? b : a,
      );
    const others = list
      .filter((group) => group !== pick)
      .flatMap((group) => group.hosts);
    const notes = [
      pick.outcome.note,
      pick.hosts.includes(input.local) ? null : `读自 ${pick.from}`,
      others.length
        ? `${others.join("、")} 登录的是另一个账号，没算进来`
        : null,
    ].filter((note): note is string => !!note);
    merged.set(provider, {
      outcome: { ...pick.outcome, note: notes.join("；") || null },
      from: pick.from,
    });
  }
  return merged;
}

export const NO_DATA = "没有额度数据";

function providerOf(row: unknown): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  const id = (row as Record<string, unknown>).providerId;
  return typeof id === "string" && id ? id : undefined;
}

/** 这一行有读数（自带读到或来自 OpenQuota），不是「读不到 / 没有额度数据」的占位行。 */
export const hasQuotaData = (row: SourcedRow) =>
  row.source === "openquota" ||
  (row.source === "builtin" && typeof row.refreshedAt === "string");

const empty = (
  providerId: string,
  source: QuotaSource | null,
  note: string,
): SourcedRow => ({ providerId, source, note });

export function mergeQuotaRows(input: {
  builtin: ReadonlyMap<string, ReaderOutcome>;
  /** 各账号自带读数来自哪台（mergeHostReadings）；没有主机信息时不给。 */
  from?: ReadonlyMap<string, string | null>;
  /** 各账号对应的编码 CLI 能在哪几台用；没有主机信息时不给。 */
  usable?: ReadonlyMap<string, string[]>;
  /** openquota pace --json 的行；没装或读失败为 undefined。 */
  openquota: readonly unknown[] | undefined;
  /** 应当出现的账号（各执行者的 quotaProvider）：两边都没有时补一行「没有额度数据」。 */
  expected?: readonly string[];
  now: number;
}): SourcedRow[] {
  const fromOpenquota = new Map<string, Record<string, unknown>>();
  for (const row of input.openquota ?? []) {
    const provider = providerOf(row);
    if (provider && !fromOpenquota.has(provider))
      fromOpenquota.set(provider, row as Record<string, unknown>);
  }
  const rows: SourcedRow[] = [];
  const seen = new Set<string>();
  for (const [providerId, outcome] of input.builtin) {
    seen.add(providerId);
    if (outcome.ok) {
      rows.push({
        ...paceRow({
          providerId,
          plan: outcome.result.plan,
          windows: outcome.result.windows,
          refreshedAt: outcome.result.refreshedAt,
          now: input.now,
        }),
        source: "builtin",
        note: outcome.note,
      });
      continue;
    }
    const fallback = fromOpenquota.get(providerId);
    rows.push(
      fallback
        ? {
            ...fallback,
            providerId,
            source: "openquota",
            note: `自带读不到：${outcome.reason}`,
          }
        : empty(providerId, "builtin", `读不到：${outcome.reason}`),
    );
  }
  for (const [providerId, row] of fromOpenquota) {
    if (seen.has(providerId)) continue;
    seen.add(providerId);
    rows.push({ ...row, providerId, source: "openquota", note: null });
  }
  for (const providerId of input.expected ?? []) {
    if (seen.has(providerId)) continue;
    seen.add(providerId);
    rows.push(empty(providerId, null, NO_DATA));
  }
  const { from, usable } = input;
  if (!from && !usable) return rows;
  return rows.map((row) => ({
    ...row,
    from:
      row.source === "builtin" && hasQuotaData(row)
        ? (from?.get(row.providerId) ?? null)
        : null,
    hosts: usable?.get(row.providerId) ?? [],
  }));
}
