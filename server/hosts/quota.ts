import type { ReaderOutcome } from "../quota-readers/index.ts";
import type { Tool } from "../tasks/adapters/types.ts";

/**
 * 额度多主机合并的来源（#358 第 2 步）：各主机代理上报的额度读数、各编码 CLI 能在哪几台用。
 * 任务运行时起来时登记一份（它手里有主机账与代理连接），`quota-source.ts` 读额度时来取；
 * 合并本身是 `quota-readers/merge.ts` 的纯函数。读数只有额度数字与账号指纹，没有凭据。
 */

export type HostQuotaSnapshot = {
  /** 本机的短号（h1）：本机自带读取器的读数算它的。 */
  local: string;
  /** 在线、没暂停的主机上装了且没判为未登录的编码 CLI。 */
  usable: { host: string; tools: Tool[] }[];
  /** 远程主机最近一次上报的读数。 */
  reports: {
    host: string;
    readings: { provider: string; outcome: ReaderOutcome }[];
  }[];
};

export type HostQuotaSource = () => HostQuotaSnapshot;

let active: HostQuotaSource | null = null;

/** 登记（或撤下）来源；撤下时只撤自己登记的那份，免得同进程里后起的服务被前一个关掉。 */
export function setHostQuotaSource(
  source: HostQuotaSource | null,
  owner?: HostQuotaSource,
) {
  if (source) active = source;
  else if (!owner || active === owner) active = null;
}

export function hostQuotaSnapshot(): HostQuotaSnapshot | null {
  try {
    return active ? active() : null;
  } catch {
    // 库已关闭等：额度照旧只看本机。
    return null;
  }
}
