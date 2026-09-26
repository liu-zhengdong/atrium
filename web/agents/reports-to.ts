import type { AgentInfo } from "../../shared/schema.ts";

/** 汇报对象；null 表示默认发给用户。 */
export type ReportsTo = AgentInfo["reports_to"];

/** 读身份的汇报对象。 */
export function reportsToOf(agent: AgentInfo): ReportsTo {
  return agent.reports_to;
}
