import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { Active } from "./active.ts";
import { collectFacts } from "./facts.ts";
import { evaluateGates, type Facts, type Verdict } from "./gates.ts";
import type { Exec } from "./git.ts";
import type { RunFields } from "./ledger.ts";
import {
  decideExit,
  exitText,
  needsFacts,
  needsGates,
  type Exit,
  type ExitDecision,
} from "./outcome.ts";
import { summarize } from "./summary.ts";

/**
 * 退出后的事实收集与关卡（#262）：读摘要、在日志末尾记退出情况、查事实、过关卡，
 * 交给 outcome.ts 的纯函数得出收尾决定。只读外部状态，不写账本。
 */

const TAIL_BYTES = 64 * 1024;

async function tail(file: string) {
  const size = (await stat(file)).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

/** 摘要：codex 的最后消息文件优先，否则取日志末尾（去掉 [atrium] 抬头与收尾行）。 */
export async function readSummary(active: Active) {
  const resultFile = active.prepared?.launch.resultFile;
  if (resultFile && existsSync(resultFile)) {
    const text = readFileSync(resultFile, "utf8").trim();
    if (text) return summarize(text);
  }
  try {
    const text = (await tail(active.logFile))
      .split("\n")
      .filter((line) => !line.startsWith("[atrium] "))
      .join("\n");
    return summarize(text);
  } catch {
    return "";
  }
}

export type Settlement = {
  summary: string;
  fields: RunFields;
  decision: ExitDecision;
  verdict?: Verdict;
  facts?: Facts;
};

export async function settle(
  active: Active,
  exit: Exit,
  exec: Exec,
): Promise<Settlement> {
  const summary = await readSummary(active);
  try {
    appendFileSync(
      active.logFile,
      `\n[atrium] ${new Date().toISOString()} ${exitText(exit)}\n`,
    );
  } catch {
    // 日志目录被删不影响收尾。
  }
  const fields: RunFields = { result: summary };
  let facts: Facts | undefined;
  let verdict: Verdict | undefined;
  if (needsFacts(active.stop)) {
    facts = await collectFacts(
      {
        repo: active.repo,
        worktree: active.worktree,
        branch: active.branch,
        base: active.base,
        summary,
      },
      exec,
    );
    fields.pr_url = facts.pr?.url ?? null;
    fields.ci = facts.ci;
  }
  if (facts && needsGates(active.stop, exit)) {
    const rules = active.worker.profile.rules;
    verdict = evaluateGates(rules.checks ?? [], rules.limits ?? {}, facts);
  }
  const decision = decideExit({
    stop: active.stop,
    exit,
    retried: active.retried,
    retryAllowed: active.worker.profile.rules.retry_on_stall !== false,
    verdict,
  });
  return { summary, fields, decision, verdict, facts };
}

/** 记进 gates 事件与完成事件的改动规模。 */
export function diffSize(facts: Facts) {
  return {
    files: facts.numstat.length,
    added: facts.numstat.reduce((sum, stat) => sum + stat.added, 0),
    removed: facts.numstat.reduce((sum, stat) => sum + stat.removed, 0),
  };
}
