import type { AdoptedEnd } from "../dispatch/adopted-exit.ts";
import type { AbnormalEnd } from "../logs/json-log.ts";
import type { OutputRules } from "./types.ts";

/**
 * 通用命令行执行者的结局（t271）：按档案的 error_match、done_match 逐行判日志末尾（纯函数）。
 * 退出码非 0 仍直接判失败（outcome.ts）；这里补「退出码 0 却出错或没做完」和服务重启后接管时的判断。
 */

const clip = (line: string) => {
  const text = line.trim();
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
};

function hits(rules: OutputRules, log: string) {
  const lines = log.split("\n");
  const error = rules.error ? new RegExp(rules.error) : undefined;
  const done = rules.done ? new RegExp(rules.done) : undefined;
  return {
    error: error && lines.findLast((line) => error.test(line)),
    done: done ? lines.some((line) => done.test(line)) : undefined,
  };
}

/** 正常退出后的异常结局：命中出错标记，或写了结束标记却没见到。 */
export function cliEnding(
  rules: OutputRules,
  log: string,
): AbnormalEnd | undefined {
  const { error, done } = hits(rules, log);
  if (error !== undefined)
    return {
      kind: "error",
      reason: `日志命中出错标记（error_match）：${clip(error)}`,
    };
  if (done === false)
    return {
      kind: "midway",
      reason: "日志里没见到结束标记（done_match），像是没做完就退出了",
    };
  return undefined;
}

/** 接管后退出（没有退出码）：出错标记在就是出错，结束标记在就是正常；都没写判不了。 */
export function cliAdopted(rules: OutputRules, log?: string): AdoptedEnd {
  if (log === undefined) return { end: "unknown" };
  const { error, done } = hits(rules, log);
  if (error !== undefined)
    return { end: "error", evidence: `命中出错标记：${clip(error)}` };
  if (done === true) return { end: "clean", evidence: "见到了结束标记" };
  if (done === false) return { end: "error", evidence: "没见到结束标记" };
  return { end: "unknown" };
}
