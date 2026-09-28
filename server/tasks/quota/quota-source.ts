import { ADAPTERS } from "../adapters/index.ts";
import { readOpenquotaPace, type OpenquotaOptions } from "./openquota.ts";
import {
  sharedQuotaReaders,
  type QuotaReaders,
} from "../../quota-readers/index.ts";
import {
  mergeHostReadings,
  mergeQuotaRows,
  type SourcedRow,
} from "../../quota-readers/merge.ts";
import type { ReaderOutcome } from "../../quota-readers/index.ts";
import {
  hostQuotaSnapshot,
  type HostQuotaSnapshot,
} from "../../hosts/quota.ts";

/**
 * 额度数据的唯一入口（#352）：自带读取器与本机 OpenQuota 同时读，按 merge.ts 合成每账号一行。
 * `atrium quota`、挑执行者（readPace）、组织树都从这里取，来源顺序一处决定。
 */

export type QuotaSourceOptions = OpenquotaOptions & {
  /** 自带读取器；缺省用服务进程共用的一份，null 表示不用自带读取。 */
  readers?: QuotaReaders | null;
  /** 各主机的读数与 CLI 分布（#358 第 2 步）；缺省取任务运行时登记的，null 表示只看本机。 */
  hosts?: HostQuotaSnapshot | null;
  now?: () => number;
};

export type QuotaRows = {
  rows: SourcedRow[];
  /** OpenQuota 装了但读失败时的一句话；没装不算问题（自带读取就是为此）。 */
  notes: string[];
};

const OPENQUOTA_FAILURE = {
  timeout: "读取 OpenQuota 额度超时",
  parse: "OpenQuota 输出无法解析",
  failed: "读取 OpenQuota 额度失败",
} as const;

/** 各执行者对应的账号，去重保序。 */
const EXPECTED_PROVIDERS: readonly string[] = [
  ...new Set(Object.values(ADAPTERS).map((adapter) => adapter.quotaProvider)),
];

export async function readQuotaRows(
  options: QuotaSourceOptions = {},
): Promise<QuotaRows> {
  const {
    readers: given,
    hosts: givenHosts,
    now = Date.now,
    ...openquota
  } = options;
  const readers = given === undefined ? sharedQuotaReaders() : given;
  const [local, pace] = await Promise.all([
    readers
      ? readers.read()
      : Promise.resolve(new Map<string, ReaderOutcome>()),
    readOpenquotaPace(openquota),
  ]);
  const notes = "error" in pace ? [OPENQUOTA_FAILURE[pace.error]] : [];
  const at = now();
  const hosts = givenHosts === undefined ? hostQuotaSnapshot() : givenHosts;
  let builtin: ReadonlyMap<string, ReaderOutcome> = local;
  let from: Map<string, string | null> | undefined;
  if (hosts) {
    const merged = mergeHostReadings({
      local: hosts.local,
      localReadings: local,
      reports: hosts.reports,
      now: at,
    });
    builtin = new Map([...merged].map(([p, m]) => [p, m.outcome]));
    from = new Map([...merged].map(([p, m]) => [p, m.from]));
  }
  return {
    rows: mergeQuotaRows({
      builtin,
      openquota: "ok" in pace ? pace.rows : undefined,
      expected: EXPECTED_PROVIDERS,
      now: at,
      ...(hosts ? { from, usable: usableByProvider(hosts) } : {}),
    }),
    notes,
  };
}

/** 各账号（provider）对应的编码 CLI 装在并登录着的主机：同一 provider 的几个工具取并集。 */
export function usableByProvider(
  hosts: Pick<HostQuotaSnapshot, "usable">,
): Map<string, string[]> {
  const usable = new Map<string, Set<string>>();
  for (const { host, tools } of hosts.usable)
    for (const tool of tools) {
      const provider = ADAPTERS[tool].quotaProvider;
      const set = usable.get(provider) ?? new Set<string>();
      set.add(host);
      usable.set(provider, set);
    }
  return new Map([...usable].map(([p, set]) => [p, [...set]]));
}
