import { ADAPTERS } from "./adapters/index.ts";
import { readOpenquotaPace, type OpenquotaOptions } from "./openquota.ts";
import {
  sharedQuotaReaders,
  type QuotaReaders,
} from "../quota-readers/index.ts";
import { mergeQuotaRows, type SourcedRow } from "../quota-readers/merge.ts";

/**
 * 额度数据的唯一入口（#352）：自带读取器与本机 OpenQuota 同时读，按 merge.ts 合成每账号一行。
 * `atrium quota`、挑执行者（readPace）、组织树都从这里取，来源顺序一处决定。
 */

export type QuotaSourceOptions = OpenquotaOptions & {
  /** 自带读取器；缺省用服务进程共用的一份，null 表示不用自带读取。 */
  readers?: QuotaReaders | null;
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
export const EXPECTED_PROVIDERS: readonly string[] = [
  ...new Set(Object.values(ADAPTERS).map((adapter) => adapter.quotaProvider)),
];

export async function readQuotaRows(
  options: QuotaSourceOptions = {},
): Promise<QuotaRows> {
  const { readers: given, now = Date.now, ...openquota } = options;
  const readers = given === undefined ? sharedQuotaReaders() : given;
  const [builtin, pace] = await Promise.all([
    readers ? readers.read() : Promise.resolve(new Map()),
    readOpenquotaPace(openquota),
  ]);
  const notes = "error" in pace ? [OPENQUOTA_FAILURE[pace.error]] : [];
  return {
    rows: mergeQuotaRows({
      builtin,
      openquota: "ok" in pace ? pace.rows : undefined,
      expected: EXPECTED_PROVIDERS,
      now: now(),
    }),
    notes,
  };
}
