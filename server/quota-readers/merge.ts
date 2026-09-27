import type { ReaderOutcome } from "./index.ts";
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
};

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
  return rows;
}
