/**
 * 验收关卡（#262）：事实不采信自述，运行时自己查到的事实交给这里判定。全部是纯函数：
 * 解析 git/gh 输出、从摘要里抽 PR 号与提交号、按档案 checks/limits 逐条判过或不过。
 */

import type { Ci, Claim, FileStat, FunctionSpan, Pr } from "./gate-parse.ts";
import { ciUnavailableReason } from "./ci-classify.ts";
import type { ScreenshotFact } from "./screenshot-facts.ts";

export * from "./gate-parse.ts";

export const GATES = [
  "pr_exists",
  "local_check",
  "ci",
  "finished",
  "file_growth",
  "claims_verified",
  "screenshot",
  "screenshots",
] as const;
export type Gate = (typeof GATES)[number];

export type CheckedClaim = Claim & { ok: boolean; detail?: string };

export type Facts = {
  /** 任务没有仓库时其余字段都没有意义。 */
  repo: boolean;
  branch?: string;
  base?: string;
  /** gh 查询用的 `-R` 仓库（origin 解析所得）；解析不出时为空，原因在 prError。 */
  ghRepo?: string;
  pr: Pr | null;
  prError?: string;
  ci: Ci | null;
  ciDetail?: string;
  numstat: FileStat[];
  functions: FunctionSpan[];
  /** 未提交（含未跟踪）的路径。 */
  dirty: string[];
  /** 比 origin/<默认分支> 多出的提交数。 */
  ahead: number;
  /** 远端同名分支与本地 HEAD 一致；null 表示查不到。 */
  pushed: boolean | null;
  pushDetail?: string;
  claims: CheckedClaim[];
  screenshots?: ScreenshotFact[];
};

export type GateResult = {
  gate: string;
  ok: boolean;
  /** 只有 ci 关卡会处于「还没出结果」。 */
  pending?: boolean;
  /** CI 基础设施没运行，需人工处理。 */
  unavailable?: boolean;
  evidence: string;
};

export type Verdict = {
  results: GateResult[];
  /** 全部通过。 */
  passed: boolean;
  /** 除了 CI 还没出结果外全部通过：先受阻，由 CI 轮询补判。 */
  awaitingCi: boolean;
  failed: GateResult[];
};

// ---- 判定 ----

type Limits = Record<string, number>;

function prExists(facts: Facts): GateResult {
  if (!facts.repo)
    return {
      gate: "pr_exists",
      ok: false,
      evidence: "任务没有仓库，无从开 PR",
    };
  if (facts.pr)
    return {
      gate: "pr_exists",
      ok: true,
      evidence: `分支 ${facts.branch} 有 PR：${facts.pr.url}（${facts.pr.state}）`,
    };
  return {
    gate: "pr_exists",
    ok: false,
    evidence: `gh pr list${facts.ghRepo ? ` -R ${facts.ghRepo}` : ""} --head ${facts.branch} 没找到 PR${facts.prError ? `：${facts.prError}` : ""}`,
  };
}

function ci(facts: Facts): GateResult {
  if (!facts.pr)
    return { gate: "ci", ok: false, evidence: "没有 PR，也就没有 CI 结果" };
  if (facts.ci === "success")
    return { gate: "ci", ok: true, evidence: `CI 通过（${facts.pr.url}）` };
  if (facts.ci === "pending")
    return {
      gate: "ci",
      ok: false,
      pending: true,
      evidence: `CI 还没出结果（${facts.pr.url}），由 CI 轮询补判`,
    };
  if (facts.ci === "unavailable")
    return {
      gate: "ci",
      ok: false,
      unavailable: true,
      evidence: ciUnavailableReason(facts.ciDetail),
    };
  if (facts.ci === "failure")
    return {
      gate: "ci",
      ok: false,
      evidence: `CI 失败（${facts.pr.url}）${facts.ciDetail ? `：${facts.ciDetail}` : ""}`,
    };
  return {
    gate: "ci",
    ok: false,
    evidence: `PR 上没有 CI 检查${facts.ciDetail ? `：${facts.ciDetail}` : ""}`,
  };
}

/** 全量检查一次交付只跑一遍：合入队列按 rebase 后的提交跑，交付关卡不重复跑，这里只说明去向。 */
function localCheck(): GateResult {
  return {
    gate: "local_check",
    ok: true,
    evidence: "全量检查由合入队列在 rebase 后跑一次，没过交回原执行者",
  };
}

function finished(facts: Facts): GateResult {
  if (!facts.repo)
    return { gate: "finished", ok: false, evidence: "任务没有仓库" };
  const missing: string[] = [];
  if (facts.dirty.length)
    missing.push(
      `有 ${facts.dirty.length} 个文件未提交（${facts.dirty.slice(0, 5).join("、")}）`,
    );
  if (facts.ahead <= 0) missing.push(`分支比 origin/${facts.base} 没有新提交`);
  if (facts.pushed !== true)
    missing.push(
      `未推送到 origin${facts.pushDetail ? `：${facts.pushDetail}` : ""}`,
    );
  if (!facts.pr) missing.push("PR 没开");
  return missing.length
    ? { gate: "finished", ok: false, evidence: `没收尾：${missing.join("；")}` }
    : {
        gate: "finished",
        ok: true,
        evidence: `已提交 ${facts.ahead} 个提交、已推送、PR 已开`,
      };
}

function fileGrowth(facts: Facts, limits: Limits): GateResult {
  const maxFile = limits.max_file_added_lines;
  const maxFunction = limits.max_function_lines;
  const problems: string[] = [];
  if (maxFile !== undefined)
    for (const stat of facts.numstat)
      if (stat.added > maxFile)
        problems.push(`${stat.file} 新增 ${stat.added} 行（上限 ${maxFile}）`);
  if (maxFunction !== undefined)
    for (const span of facts.functions)
      if (span.lines > maxFunction)
        problems.push(
          `${span.file} 的 ${span.name} 有 ${span.lines} 行（上限 ${maxFunction}）`,
        );
  if (maxFile === undefined && maxFunction === undefined)
    return {
      gate: "file_growth",
      ok: true,
      evidence: "档案没给 limits，未设上限",
    };
  const total = facts.numstat.reduce((sum, stat) => sum + stat.added, 0);
  return problems.length
    ? {
        gate: "file_growth",
        ok: false,
        evidence: problems.slice(0, 10).join("；"),
      }
    : {
        gate: "file_growth",
        ok: true,
        evidence: `${facts.numstat.length} 个文件共新增 ${total} 行，未超限`,
      };
}

function screenshots(
  facts: Facts,
  gate: "screenshot" | "screenshots",
): GateResult {
  if (!facts.pr)
    return { gate, ok: false, evidence: "没有 PR；请开 PR 并在正文附截图" };
  if (!facts.screenshots?.length)
    return {
      gate,
      ok: false,
      evidence: "PR 正文没有图片；请添加 Markdown 图片或 GitHub 图片附件链接",
    };
  const bad = facts.screenshots.filter((image) => image.status !== 200);
  const showUrl = (value: string) => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "无效图片链接";
    }
  };
  return {
    gate,
    ok: bad.length === 0,
    evidence: bad.length
      ? `截图链接 HEAD 未返回 200：${bad.map((image) => `${showUrl(image.url)}（${image.status ?? image.error ?? "未检查"}）`).join("；")}`
      : `PR 正文 ${facts.screenshots.length} 张截图均可访问（HEAD 200）`,
  };
}

function claimsVerified(facts: Facts): GateResult {
  if (!facts.claims.length)
    return {
      gate: "claims_verified",
      ok: true,
      evidence: "摘要里没有提到 PR 号或提交号",
    };
  const bad = facts.claims.filter((claim) => !claim.ok);
  const label = (claim: CheckedClaim) =>
    claim.kind === "pr" ? `PR #${claim.value}` : `提交 ${claim.value}`;
  return bad.length
    ? {
        gate: "claims_verified",
        ok: false,
        evidence: `核对不上：${bad.map((claim) => `${label(claim)}${claim.detail ? `（${claim.detail}）` : ""}`).join("；")}`,
      }
    : {
        gate: "claims_verified",
        ok: true,
        evidence: `核对了 ${facts.claims.map(label).join("、")}，都存在`,
      };
}

export function evaluateGates(
  checks: readonly string[],
  limits: Limits,
  facts: Facts,
): Verdict {
  const results = [...new Set(checks)].map((gate): GateResult => {
    switch (gate) {
      case "pr_exists":
        return prExists(facts);
      case "local_check":
        return localCheck();
      case "ci":
        return ci(facts);
      case "finished":
        return finished(facts);
      case "file_growth":
        return fileGrowth(facts, limits);
      case "claims_verified":
        return claimsVerified(facts);
      case "screenshot":
      case "screenshots":
        return screenshots(facts, gate);
      default:
        return {
          gate,
          ok: false,
          evidence: `档案里的关卡 ${gate} 不认识；可用 ${GATES.join("、")}`,
        };
    }
  });
  const failed = results.filter((result) => !result.ok);
  return {
    results,
    passed: failed.length === 0,
    awaitingCi: failed.length > 0 && failed.every((result) => result.pending),
    failed,
  };
}
