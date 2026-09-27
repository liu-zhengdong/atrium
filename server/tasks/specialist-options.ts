import { Problem } from "../problem.ts";

/** 新旧参数的优先关系在入库前统一判定；空串表示清空。 */
export function specialistOptions(input: Record<string, unknown>) {
  for (const key of ["by", "ask"])
    if (key in input && input[key] !== null && typeof input[key] !== "string")
      throw new Problem(400, `${key}: 应为专员名称或短号`, "usage");
  if ("by" in input && "job" in input)
    throw new Problem(400, "by: 与旧写法 job 只能给一个", "usage");
  if ("ask" in input && "concern" in input)
    throw new Problem(400, "ask: 与旧写法 concern 只能给一个", "usage");
  return {
    byPresent: "by" in input || "job" in input,
    by: "by" in input ? input.by : input.job,
    askPresent: "ask" in input || "concern" in input,
    ask: "ask" in input ? input.ask : input.concern,
    modernAsk: "ask" in input,
  };
}
