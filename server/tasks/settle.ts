import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { Active } from "./active.ts";
import { ADAPTERS } from "./adapters/index.ts";
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
import { abnormalEnding, parseEvents } from "./json-log.ts";
import { quotaReason } from "./quota-holds.ts";
import { detectQuotaExhausted } from "./quota-signal.ts";
import { summarize } from "./summary.ts";
import { detectTransient, type TransientHit } from "./transient.ts";

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

/** 日志末尾（去掉 [atrium] 抬头与收尾行）；读不到时为 undefined。 */
async function readLog(active: Active) {
  try {
    return (await tail(active.logFile))
      .split("\n")
      .filter((line) => !line.startsWith("[atrium] "))
      .join("\n");
  } catch {
    return undefined;
  }
}

const jsonEvents = (active: Active) =>
  ADAPTERS[active.tool].progressSignals.includes("json_events");

/** 摘要：codex 的最后消息文件优先；结构化日志取最后一条助手文本；否则取日志末尾。 */
function readSummary(active: Active, log: string | undefined) {
  const resultFile = active.prepared?.launch.resultFile;
  if (resultFile && existsSync(resultFile)) {
    const text = readFileSync(resultFile, "utf8").trim();
    if (text) return summarize(text);
  }
  return log === undefined ? "" : summarize(log, jsonEvents(active));
}

/** 额度判定只看日志最后这么多字符：更早的部分可能是执行者回显的提示词，里面也会有「额度」字样。 */
const QUOTA_TAIL_CHARS = 4096;

export type QuotaHit = {
  provider: string;
  resetAt: Date | null;
  /** 任务受阻原因：「额度用尽：<provider>，预计 <时刻> 恢复」。 */
  reason: string;
  /** 报文证据（quota-signal 给出的原因与原文行）。 */
  evidence: string;
};

/** 执行者退出后按日志末尾判额度用尽（#267）；被停下的（人工、卡死、空闲）不判。 */
function detectQuota(
  active: Active,
  exit: Exit,
  log: string | undefined,
): QuotaHit | undefined {
  if (active.stop || log === undefined) return undefined;
  const verdict = detectQuotaExhausted({
    exitCode: exit === "unknown" ? null : exit.code,
    logTail: log.slice(-QUOTA_TAIL_CHARS),
    now: new Date(),
    tool: active.tool,
  });
  if (!verdict.exhausted) return undefined;
  return {
    provider: verdict.provider,
    resetAt: verdict.resetAt,
    reason: quotaReason(verdict.provider, verdict.resetAt),
    evidence: verdict.reason,
  };
}

export type Settlement = {
  summary: string;
  fields: RunFields;
  decision: ExitDecision;
  verdict?: Verdict;
  facts?: Facts;
  quota?: QuotaHit;
  /** 供应商或网络临时错误：收尾后按 transient.ts 重试或换执行者。 */
  transient?: TransientHit;
};

export async function settle(
  active: Active,
  exit: Exit,
  exec: Exec,
): Promise<Settlement> {
  const log = await readLog(active);
  const summary = readSummary(active, log);
  try {
    appendFileSync(
      active.logFile,
      `\n[atrium] ${new Date().toISOString()} ${exitText(exit)}\n`,
    );
  } catch {
    // 日志目录被删不影响收尾。
  }
  const fields: RunFields = { result: summary };
  const quota = detectQuota(active, exit, log);
  if (quota) {
    // 额度用尽：不查事实、不过关卡，直接受阻。
    const decision = decideExit({
      exit,
      retried: active.retried,
      retryAllowed: false,
      quota: quota.reason,
    });
    return { summary, fields, decision, quota };
  }
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
  const ending =
    log !== undefined && jsonEvents(active)
      ? abnormalEnding(parseEvents(log))
      : undefined;
  // 长度用尽、权限被拒是执行者自己的结局，重试也一样；被停下的也不判。
  const transient =
    active.stop || log === undefined || (ending && ending.kind !== "midway")
      ? undefined
      : detectTransient({
          exitCode: exit === "unknown" ? null : exit.code,
          logTail: log,
          json: jsonEvents(active),
        });
  const decision = decideExit({
    stop: active.stop,
    exit,
    retried: active.retried,
    retryAllowed: active.worker.profile.rules.retry_on_stall !== false,
    verdict,
    ending: ending?.reason,
    transient: transient?.reason,
  });
  return { summary, fields, decision, verdict, facts, transient };
}

/** 记进 gates 事件与完成事件的改动规模。 */
export function diffSize(facts: Facts) {
  return {
    files: facts.numstat.length,
    added: facts.numstat.reduce((sum, stat) => sum + stat.added, 0),
    removed: facts.numstat.reduce((sum, stat) => sum + stat.removed, 0),
  };
}
