/**
 * 验收关卡用到的解析（#262）：git numstat、gh pr checks、diff 里新增的函数、摘要里的声明。纯函数。
 */

export type Ci = "pending" | "success" | "failure" | "unavailable";
export type Pr = { number: number; url: string; state: string; body?: string };
export type FileStat = { file: string; added: number; removed: number };
export type FunctionSpan = { file: string; name: string; lines: number };
export type Claim = { kind: "pr" | "commit"; value: string };

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
