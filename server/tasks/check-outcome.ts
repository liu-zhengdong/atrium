/**
 * 本地检查结果分三类（t204）：纯函数，穷举测试。
 *
 * - 过（passed）：检查通过。
 * - 没过（failed）：有失败用例且不是基础设施问题，照旧交回执行者。
 * - 没跑成（not_run）：主机离线、没派过去、代理没来领、检查进程被杀，
 *   或超时／失败但失败用例全是仓库登记的时长敏感用例。不算执行者没过：换一台或等负载降下来自动重跑，
 *   最多 MAX_CHECK_RERUNS 次，之后才转卡住并写明「基础设施问题」。
 *
 * 时长敏感用例登记在仓库基础分支的 `.agents/timing-sensitive`（每行一段用例名或测试文件名，`#` 开头是注释），
 * 从 origin/<基础分支> 读，执行者在自己分支里改它不算数。
 */

import type { LocalCheck } from "./local-check.ts";

export type CheckClass = "passed" | "failed" | "not_run";

export const CHECK_CLASS_TEXT: Record<CheckClass, string> = {
  passed: "过",
  failed: "没过",
  not_run: "没跑成",
};

/** 没跑成最多自动重跑几次；之后转卡住。 */
export const MAX_CHECK_RERUNS = 3;

/** 仓库里登记时长敏感用例的文件（相对仓库根）。 */
export const TIMING_SENSITIVE_FILE = ".agents/timing-sensitive";

/** 失败用例名只取了前这么多个（local-check.ts failedTestNames）；到了上限就不知道后面还有什么，按没过算。 */
const FAILED_TESTS_CAP = 10;

/** 解析 `.agents/timing-sensitive`：去空行与 `#` 注释，路径分隔统一成 `/`。 */
export function parseTimingSensitive(text: string): string[] {
  const patterns = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    patterns.add(line.replaceAll("\\", "/").slice(0, 200));
  }
  return [...patterns].slice(0, 200);
}

/** 用例名去掉结尾的耗时「(123.4ms)」与 `# SKIP` 之类的标记，路径分隔统一成 `/`。 */
export function testName(name: string) {
  return name
    .replace(/\s+#\s*(SKIP|TODO)\b.*$/i, "")
    .replace(/\s*\(\d+(?:\.\d+)?m?s\)\s*$/, "")
    .replaceAll("\\", "/")
    .trim();
}

/** 这个失败用例是不是登记过的时长敏感用例：登记的一段出现在用例名（或测试文件路径）里。 */
export function isTimingSensitive(name: string, patterns: readonly string[]) {
  const normalized = testName(name);
  return (
    !!normalized && patterns.some((pattern) => normalized.includes(pattern))
  );
}

export type Classified = { outcome: CheckClass; reason: string };

export function classifyCheck(
  check: Pick<LocalCheck, "status" | "detail" | "failedTests" | "infra">,
  patterns: readonly string[],
): Classified {
  if (check.status === "passed")
    return { outcome: "passed", reason: "检查通过" };
  if (check.infra) return { outcome: "not_run", reason: check.infra };
  const failed = check.failedTests;
  const allSensitive =
    failed.length < FAILED_TESTS_CAP &&
    failed.every((name) => isTimingSensitive(name, patterns));
  const listed = failed.map(testName).join("、");
  if (check.status === "timeout")
    return allSensitive
      ? {
          outcome: "not_run",
          reason: failed.length
            ? `${check.detail}，失败用例都是已知的时长敏感用例（${listed}）`
            : `${check.detail}，没有失败用例`,
        }
      : {
          outcome: "failed",
          reason: `${check.detail}；失败用例：${listed}`,
        };
  if (check.status === "failed" && failed.length && allSensitive)
    return {
      outcome: "not_run",
      reason: `失败用例都是已知的时长敏感用例（${listed}）`,
    };
  return {
    outcome: "failed",
    reason: listed ? `${check.detail}；失败用例：${listed}` : check.detail,
  };
}

/** 第 attempt 次重跑（1 起）前至少等多久：给负载降下来、离线主机连回来的时间。 */
export function rerunDelayMs(attempt: number) {
  return [60_000, 180_000, 300_000][Math.min(Math.max(attempt, 1), 3) - 1]!;
}

/** 没跑成之后怎么办：还没到上限就重跑，否则转卡住。 */
export function rerunDecision(input: {
  outcome: CheckClass;
  reruns: number;
}): "rerun" | "final" {
  if (input.outcome !== "not_run") return "final";
  if (input.reruns >= MAX_CHECK_RERUNS) return "final";
  return "rerun";
}

/** 重跑用尽仍没跑成：关卡与受阻原因里的写法。 */
export function notRunText(reason: string, reruns: number) {
  return `基础设施问题：检查没跑成${reruns ? `（已自动重跑 ${reruns} 次）` : ""}：${reason}`;
}

/** 等重跑时的一句话（状态栏、task show）。 */
export function rerunText(attempt: number, reason: string) {
  return `检查没跑成，等重跑（第 ${attempt}/${MAX_CHECK_RERUNS} 次）：${reason}`;
}

/** 检查结果带上分类与已重跑次数（写进事件，`task show` 一眼看到是哪一类）。 */
export function withOutcome(
  check: LocalCheck,
  patterns: readonly string[],
  reruns = 0,
): LocalCheck {
  const { outcome, reason } = classifyCheck(check, patterns);
  return {
    ...check,
    outcome,
    ...(outcome === "not_run" ? { reason } : {}),
    ...(reruns ? { reruns } : {}),
  };
}

/** 从检查记录的 host（hN）取主机号；不是 hN 为 null。 */
export function hostIdOf(ref: string | undefined): number | null {
  const match = ref?.match(/^h([1-9][0-9]*)$/);
  return match ? Number(match[1]) : null;
}

/**
 * `task show` 的「本地检查」一行：最近一次检查事件（交付后 local_check*、合入前 merge_check*）说成人话。
 * 旧记录没有分类时按结论推：通过为过，其余为没过。
 */
export function checkSummary(event: {
  kind: string;
  detail: Record<string, unknown>;
}): string | null {
  const stage = event.kind.startsWith("merge_") ? "合入前" : "交付后";
  const d = event.detail;
  const str = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : "";
  const host = str(d.host);
  const at = host ? `（${host}）` : "";
  const why = str(d.reason) || str(d.detail);
  if (event.kind.endsWith("_rerun")) {
    const attempt = typeof d.attempt === "number" ? d.attempt : 1;
    return `${stage}${CHECK_CLASS_TEXT.not_run}${at}，已安排重跑（${attempt}/${MAX_CHECK_RERUNS}）：${why}`;
  }
  const outcome: CheckClass | null =
    d.outcome === "passed" || d.outcome === "failed" || d.outcome === "not_run"
      ? d.outcome
      : typeof d.status === "string"
        ? d.status === "passed"
          ? "passed"
          : "failed"
        : null;
  if (!outcome) return null;
  if (outcome === "passed") return `${stage}${CHECK_CLASS_TEXT.passed}${at}`;
  if (outcome === "not_run") {
    const reruns = typeof d.reruns === "number" ? d.reruns : 0;
    return `${stage}${CHECK_CLASS_TEXT.not_run}${at}（基础设施问题${reruns ? `，已自动重跑 ${reruns} 次` : ""}）：${why}`;
  }
  const failed = Array.isArray(d.failedTests)
    ? d.failedTests.filter((t): t is string => typeof t === "string")
    : [];
  return `${stage}${CHECK_CLASS_TEXT.failed}${at}：${str(d.detail)}${failed.length ? `；失败用例：${failed.map(testName).join("、")}` : ""}`;
}

/** 算「本地检查」一行时看的事件种类。 */
export const CHECK_EVENT_KINDS = [
  "local_check",
  "merge_check",
  "merge_check_rerun",
] as const;
