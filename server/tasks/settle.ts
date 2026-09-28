import { readFileSync, statSync, appendFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { Active } from "./active.ts";
import { adoptedEnd } from "./adopted-exit.ts";
import { ADAPTERS, claudeStream } from "./adapters/index.ts";
import { collectFacts } from "./facts.ts";
import { type Facts, type Verdict } from "./gates.ts";
import { collectComments } from "./comment-facts.ts";
import { evaluateDelivery } from "./delivery-gates.ts";
import type { Exec } from "./git.ts";
import type { RunFields } from "./ledger.ts";
import {
  decideExit,
  exitDetail,
  exitText,
  needsFacts,
  needsGates,
  type Exit,
  type ExitDecision,
} from "./outcome.ts";
import { abnormalEnding, parseEvents, type AbnormalEnd } from "./json-log.ts";
import { quotaReason } from "./quota-holds.ts";
import { detectQuotaExhausted } from "./quota-signal.ts";
import { summarize } from "./summary.ts";
import { detectTransient, type TransientHit } from "./transient.ts";

/**
 * 退出后的事实收集与关卡（#262）：读摘要、在日志末尾记退出情况、查事实、过关卡，
 * 交给 outcome.ts 的纯函数得出收尾决定。只读外部状态，不写账本。
 */

const TAIL_BYTES = 64 * 1024;

export async function logTail(file: string, bytes = TAIL_BYTES) {
  const size = (await stat(file)).size;
  const start = Math.max(0, size - bytes);
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
    return (await logTail(active.logFile))
      .split("\n")
      .filter((line) => !line.startsWith("[atrium] "))
      .join("\n");
  } catch {
    return undefined;
  }
}

const jsonEvents = (active: Active) =>
  ADAPTERS[active.tool].progressSignals.includes("json_events");

/** codex 本轮写出的最后消息（-o）；接管的进程按任务目录里的固定位置找，早于本轮开始的是上一轮留下的。 */
function readLastMessage(active: Active) {
  // 远程的最后消息由代理传回本机任务目录（active.resultFile）。
  const resultFile = active.host
    ? active.resultFile
    : (active.prepared?.launch.resultFile ?? active.resultFile);
  if (!resultFile) return undefined;
  try {
    if (statSync(resultFile).mtimeMs < active.startedAt) return undefined;
    return readFileSync(resultFile, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** 摘要：codex 的最后消息文件优先；结构化日志取最后一条助手文本；否则取日志末尾。 */
function readSummary(
  active: Active,
  log: string | undefined,
  lastMessage: string | undefined,
) {
  if (lastMessage) return summarize(lastMessage);
  return log === undefined ? "" : summarize(log, jsonEvents(active));
}

/** 本轮的收尾摘要，取法与收尾时相同；结论补答前看一眼用（conclusion-runtime.ts）。 */
export async function finalSummary(active: Active) {
  return readSummary(active, await readLog(active), readLastMessage(active));
}

/** 额度判定只看日志最后这么多字符：更早的部分可能是执行者回显的提示词，里面也会有「额度」字样。 */
const QUOTA_TAIL_CHARS = 4096;

/** 重启时退出码遗失，远端交付事实足以让任务继续走正常关卡。 */
export const deliveredDespiteUnknownExit = (exit: Exit, facts?: Facts) =>
  exit === "unknown" && !!facts?.pr && facts.ci === "success";

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
  /** 从结构化日志识别出的异常结束；思考耗尽时收尾后按 thinking.ts 换执行者重跑。 */
  ending?: AbnormalEnd;
  /** 运行时在执行日志里看见命令行防护的固定拒绝语句。 */
  workerGuardRefused?: boolean;
  /** 退出情况与判定依据，写进 gates 与状态转移事件。 */
  exitDetail: Record<string, unknown>;
};

export async function settle(
  active: Active,
  exit: Exit,
  exec: Exec,
): Promise<Settlement> {
  const log = await readLog(active);
  const workerGuardRefused =
    log?.includes("执行者环境里不能操作用户的 Atrium 服务") ?? false;
  const lastMessage = readLastMessage(active);
  const summary = readSummary(active, log, lastMessage);
  // 接管后退出没有退出码：按日志收尾结构判正常结束还是出错。
  const adopted =
    exit === "unknown"
      ? adoptedEnd({
          tool: claudeStream(active.tool) ? "claude" : active.tool,
          log,
          lastMessage,
        })
      : undefined;
  try {
    appendFileSync(
      active.logFile,
      `\n[atrium] ${new Date().toISOString()} ${exitText(exit, adopted)}\n`,
    );
  } catch {
    // 日志目录被删不影响收尾。
  }
  const fields: RunFields = { result: summary };
  const endedAt = Date.now();
  let facts: Facts | undefined;
  if (
    exit === "unknown" &&
    active.deliver === "pr" &&
    needsFacts(active.stop)
  ) {
    facts = await collectFacts(
      {
        repo: active.repo,
        worktree: active.worktree,
        branch: active.branch,
        base: active.base,
        summary,
      },
      exec,
      // 没有 ci 关卡了；只在接管后退出时查 CI，作「交付已在」的依据（deliveredDespiteUnknownExit）。
      true,
      active.worker.profile.rules.checks?.some((gate) =>
        ["screenshot", "screenshots"].includes(gate),
      ) ?? false,
    );
    fields.pr_url = facts.pr?.url ?? null;
    fields.ci = facts.ci;
  }
  const quota = deliveredDespiteUnknownExit(exit, facts)
    ? undefined
    : detectQuota(active, exit, log);
  if (quota) {
    // 额度用尽：不查事实、不过关卡，直接受阻。
    const decision = decideExit({
      exit,
      retried: active.retried,
      retryAllowed: false,
      quota: quota.reason,
    });
    return {
      summary,
      fields,
      decision,
      quota,
      exitDetail: exitDetail(exit, adopted),
    };
  }
  let verdict: Verdict | undefined;
  if (!facts && active.deliver === "pr" && needsFacts(active.stop)) {
    facts = await collectFacts(
      {
        repo: active.repo,
        worktree: active.worktree,
        branch: active.branch,
        base: active.base,
        summary,
      },
      exec,
      false,
      active.worker.profile.rules.checks?.some((gate) =>
        ["screenshot", "screenshots"].includes(gate),
      ) ?? false,
    );
    fields.pr_url = facts.pr?.url ?? null;
    fields.ci = facts.ci;
  }
  if (needsGates(active.stop, exit)) {
    const rules = active.worker.profile.rules;
    // 全量检查只在合入队列 rebase 后跑一次（local_check 关卡见 gates.ts），交付时不跑。
    const comments =
      active.deliver === "comment" && active.issue
        ? await collectComments(
            active.repo,
            active.issue,
            active.startedAt,
            exec,
          )
        : undefined;
    verdict = evaluateDelivery({
      deliver: active.deliver,
      issue: active.issue,
      startedAt: active.startedAt,
      endedAt,
      comments,
      checks: rules.checks ?? [],
      limits: rules.limits ?? {},
      facts,
    });
    const link = verdict.results
      .find((result) => result.gate === "comment" && result.ok)
      ?.evidence.match(/https:\/\/\S+/)?.[0];
    if (link)
      fields.result = [summary, `评论：${link}`].filter(Boolean).join("\n");
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
  const delivered = deliveredDespiteUnknownExit(exit, facts);
  const decision = decideExit({
    stop: active.stop,
    exit,
    retried: active.retried,
    retryAllowed: active.worker.profile.rules.retry_on_stall !== false,
    verdict,
    ending: ending?.reason,
    abnormalFatal: active.deliver !== "pr",
    thinking: ending?.kind === "thinking",
    transient: transient?.reason,
    // 远端已交付（PR 在、CI 过）的照常过关卡，不因日志里的出错判失败。
    adopted: delivered ? undefined : adopted,
  });
  return {
    summary,
    fields,
    decision,
    verdict,
    facts,
    transient,
    ending,
    workerGuardRefused,
    exitDetail: exitDetail(exit, adopted, delivered),
  };
}

/** 记进 gates 事件与完成事件的改动规模。 */
export function diffSize(facts: Facts) {
  return {
    files: facts.numstat.length,
    added: facts.numstat.reduce((sum, stat) => sum + stat.added, 0),
    removed: facts.numstat.reduce((sum, stat) => sum + stat.removed, 0),
  };
}
