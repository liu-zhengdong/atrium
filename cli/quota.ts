import { recordNext, recordResult } from "./contract.ts";
import { printJson, table, when } from "./format.ts";
import type { Command } from "./main.ts";
import { Problem } from "../server/problem.ts";
import type { QuotaAccount, QuotaList } from "../server/tasks/quota.ts";

/**
 * 账号额度一览的命令行（#267、#352）：只经 HTTP 调服务，不直接读凭据或跑 OpenQuota。
 * 「来源」列：自带（Atrium 自己读的）或 OpenQuota；「说明」列写读不到的原因或没有额度数据。
 * 「运行时记录」列由服务给：账号被额度标记挡住时写明预计恢复时刻（或恢复时间未知），
 * 没有标记留空；--json 里同一信息是结构化的 hold.until / hold.reason。
 */

const client = async () => (await import("./service.ts")).connect();

function cell(value: number | null): string {
  if (value === null) return "";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function refreshed(value: string | null): string {
  if (!value) return "";
  const at = Date.parse(value);
  return Number.isFinite(at) ? when(at) : value;
}

const SOURCE_LABEL = { builtin: "自带", openquota: "OpenQuota" } as const;

export function formatQuotaTable(
  accounts: QuotaAccount[],
  notes: readonly string[] = [],
): string {
  const tail = notes.length ? `\n${notes.join("\n")}` : "";
  if (!accounts.length) return `没有账号额度数据${tail}`;
  const body = table([
    [
      "账号",
      "来源",
      "已用%",
      "周期进度%",
      "富余%",
      "距重置（小时）",
      "短窗已用%",
      "刷新时间",
      "运行时记录",
      "说明",
    ],
    ...accounts.map((account) => [
      account.providerId,
      account.source ? SOURCE_LABEL[account.source] : "",
      cell(account.usedPercent),
      cell(account.periodElapsedPercent),
      cell(account.sparePercent),
      cell(account.hoursToReset),
      cell(account.shortWindowUsedPercent),
      refreshed(account.refreshedAt),
      account.runtime ?? "",
      account.note ?? "",
    ]),
  ]);
  return `${body}${tail}`;
}

const quota: Command = {
  args: "[--clear <账号>] [--json]",
  about: "列出账号额度；--clear 人工解除运行时占用并立即重派排队任务",
  options: { clear: { type: "string" } },
  positionals: [0, 0],
  async run({ json, values }) {
    const provider =
      typeof values.clear === "string" ? values.clear : undefined;
    if (values.clear !== undefined) {
      if (!provider || !/^[a-z][a-z0-9_-]{0,63}$/.test(provider))
        throw new Problem(400, "--clear: 账号名不合法", "usage");
      const result = await (
        await client()
      ).post<{ provider: string; cleared: boolean; dispatched: number }>(
        `/quota/${encodeURIComponent(provider)}/clear`,
        {},
      );
      recordResult(result);
      if (json) printJson(result);
      else
        console.log(
          `已解除 ${provider} 的运行时额度占用；立即派发 ${result.dispatched} 个排队任务`,
        );
      recordNext("看任务：atrium task ls");
      return;
    }
    const result = await (await client()).get<QuotaList>("/quota");
    if (json) printJson(result);
    else console.log(formatQuotaTable(result.accounts, result.notes ?? []));
    recordNext("看任务：atrium task ls");
  },
};

export const quotaCommands: Record<string, Command> = { quota };
