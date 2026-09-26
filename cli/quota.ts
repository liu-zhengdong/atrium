import { recordNext } from "./contract.ts";
import { printJson, table, when } from "./format.ts";
import type { Command } from "./main.ts";
import type { QuotaAccount, QuotaList } from "../server/tasks/quota.ts";

/**
 * 账号额度一览的命令行（#267）：只经 HTTP 调服务，不直接跑 OpenQuota。
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

export function formatQuotaTable(accounts: QuotaAccount[]): string {
  if (!accounts.length) return "没有账号额度数据";
  return table([
    [
      "账号",
      "已用%",
      "周期进度%",
      "富余%",
      "距重置（小时）",
      "短窗已用%",
      "刷新时间",
      "运行时记录",
    ],
    ...accounts.map((account) => [
      account.providerId,
      cell(account.usedPercent),
      cell(account.periodElapsedPercent),
      cell(account.sparePercent),
      cell(account.hoursToReset),
      cell(account.shortWindowUsedPercent),
      refreshed(account.refreshedAt),
      account.runtime ?? "",
    ]),
  ]);
}

const quota: Command = {
  args: "[--json]",
  about: "按额度富余从多到少列出各账号，标出额度用尽待恢复的账号",
  positionals: [0, 0],
  async run({ json }) {
    const result = await (await client()).get<QuotaList>("/quota");
    if (json) printJson(result);
    else console.log(formatQuotaTable(result.accounts));
    recordNext("看任务：atrium task ls");
  },
};

export const quotaCommands: Record<string, Command> = { quota };
