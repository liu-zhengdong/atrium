/**
 * 验收关卡（#262）：事实不采信自述，运行时自己查到的事实交给这里判定。全部是纯函数：
 * 解析 git/gh 输出、从摘要里抽 PR 号与提交号、按档案 checks/limits 逐条判过或不过。
 */

export const GATES = [
  "pr_exists",
  "ci",
  "finished",
  "file_growth",
  "claims_verified",
] as const;
export type Gate = (typeof GATES)[number];

export type Ci = "pending" | "success" | "failure";
export type Pr = { number: number; url: string; state: string };
export type FileStat = { file: string; added: number; removed: number };
export type FunctionSpan = { file: string; name: string; lines: number };
export type Claim = { kind: "pr" | "commit"; value: string };
export type CheckedClaim = Claim & { ok: boolean; detail?: string };

export type Facts = {
  /** 任务没有仓库时其余字段都没有意义。 */
  repo: boolean;
  branch?: string;
  base?: string;
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
};

export type GateResult = {
  gate: string;
  ok: boolean;
  /** 只有 ci 关卡会处于「还没出结果」。 */
  pending?: boolean;
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

// ---- 解析 ----

/** `git diff --numstat` 输出；二进制文件（- -）记 0 行。 */
export function parseNumstat(text: string): FileStat[] {
  const stats: FileStat[] = [];
  for (const line of text.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    stats.push({
      file: match[3]!,
      added: match[1] === "-" ? 0 : Number(match[1]),
      removed: match[2] === "-" ? 0 : Number(match[2]),
    });
  }
  return stats;
}

/** `gh pr checks --json bucket` 的汇总：有失败即失败，有未出结果即 pending，没有检查为 null。 */
export function ciFromChecks(
  checks: readonly { bucket?: string }[],
): Ci | null {
  if (!checks.length) return null;
  const buckets = checks.map((check) => check.bucket ?? "");
  if (buckets.some((bucket) => bucket === "fail" || bucket === "cancel"))
    return "failure";
  if (buckets.some((bucket) => bucket === "pending")) return "pending";
  return "success";
}

const FUNCTION_START = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::\s*[^=]+)?=>/,
  /^\s*(?:(?:public|private|protected|static|async|override|readonly)\s+)*([\w$]+)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{\s*$/,
  /^\s*(?:async\s+)?def\s+(\w+)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/,
];
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return"]);

function functionStart(line: string): string | undefined {
  for (const pattern of FUNCTION_START) {
    const match = pattern.exec(line);
    if (match && !KEYWORDS.has(match[1] ?? "")) return match[1] || "(匿名)";
  }
  return undefined;
}

const braces = (line: string) => {
  // 粗略去掉字符串与行注释，避免其中的括号干扰计数。
  const code = line
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "")
    .replace(/\/\/.*$/, "");
  let delta = 0;
  for (const ch of code) {
    if (ch === "{") delta++;
    else if (ch === "}") delta--;
  }
  return delta;
};
const indent = (line: string) => /^\s*/.exec(line)![0].length;

/** 一段连续新增行里的函数长度（启发式：花括号配平；Python 按缩进）。 */
function spans(file: string, lines: string[]): FunctionSpan[] {
  const found: FunctionSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const name = functionStart(lines[i]!);
    if (name === undefined) continue;
    let end = i;
    if (/^\s*(?:async\s+)?def\s/.test(lines[i]!)) {
      const base = indent(lines[i]!);
      while (
        end + 1 < lines.length &&
        (!lines[end + 1]!.trim() || indent(lines[end + 1]!) > base)
      )
        end++;
    } else {
      let depth = 0;
      let opened = false;
      for (let j = i; j < lines.length; j++) {
        depth += braces(lines[j]!);
        if (lines[j]!.includes("{")) opened = true;
        end = j;
        if (opened && depth <= 0) break;
        // 单行箭头函数：没有花括号且以分号或逗号收尾。
        if (!opened && /[;,]\s*$/.test(lines[j]!)) break;
      }
    }
    found.push({ file, name, lines: end - i + 1 });
    // 外层函数已计完整长度，内层嵌套函数不再单独计。
    i = end;
  }
  return found;
}

/** 从 `git diff -U0` 输出里找新增的函数及其行数。 */
export function addedFunctions(diff: string): FunctionSpan[] {
  const result: FunctionSpan[] = [];
  let file = "";
  let run: string[] = [];
  const flush = () => {
    if (file && run.length) result.push(...spans(file, run));
    run = [];
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      flush();
      file = line.slice(4).replace(/^b\//, "");
      if (file === "/dev/null") file = "";
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      run.push(line.slice(1));
    } else flush();
  }
  flush();
  return result;
}

/**
 * 从执行者摘要里抽出可核对的声明：`PR #12`、`pull/12`、提交号（7～40 位十六进制，
 * 至少含一个数字和一个字母，免得把普通数字、单词当成提交号）。issue 引用（Closes #12）不算 PR 声明。
 */
export function extractClaims(text: string): Claim[] {
  const claims = new Map<string, Claim>();
  const pr = /(?:\bPR\s*#?\s*|pull request\s*#?\s*|\/pull\/)(\d{1,7})\b/gi;
  for (const match of text.matchAll(pr))
    claims.set(`pr:${match[1]}`, { kind: "pr", value: match[1]! });
  for (const match of text.matchAll(/(?<![\w/.-])[0-9a-f]{7,40}(?![\w-])/g)) {
    const sha = match[0];
    if (!/[0-9]/.test(sha) || !/[a-f]/.test(sha)) continue;
    claims.set(`commit:${sha}`, { kind: "commit", value: sha });
  }
  return [...claims.values()].slice(0, 20);
}

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
    evidence: `gh pr list --head ${facts.branch} 没找到 PR${facts.prError ? `：${facts.prError}` : ""}`,
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
      case "ci":
        return ci(facts);
      case "finished":
        return finished(facts);
      case "file_growth":
        return fileGrowth(facts, limits);
      case "claims_verified":
        return claimsVerified(facts);
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
