import { failedTestNames } from "./local-check.ts";

/**
 * 盯发版工作流（t265）：合入后还没有含它的版本时，看仓库的发版工作流跑到哪了。
 * 失败（或合入很久都没跑起来）就给任务记「上线失败」、叫醒负责人，紧急通道据此解除让路。
 * 这里只放判定（纯函数、穷举测试）；调 gh 与落库在 `release-watch.ts`、`online-runtime.ts`。
 */

/** 发版工作流的文件名（`.github/workflows/release.yml`）。 */
export const RELEASE_WORKFLOW = "release.yml";
/** 一次看最近多少次发版运行。 */
export const RELEASE_RUNS_LIMIT = 20;
/** 合入多久还没有发版运行，就当工作流没跑起来。 */
export const RELEASE_NO_RUN_MS = 10 * 60_000;
/** 日志摘要至多几行、多少字。 */
const LOG_LINES = 20;
const LOG_CHARS = 1500;

export type ReleaseRun = {
  id: number;
  /** 触发这次运行的提交。 */
  sha: string;
  /** queued、in_progress、completed 等。 */
  status: string;
  /** 结束后的结论：success、failure、cancelled……；没结束为 null。 */
  conclusion: string | null;
  createdAt: number;
  url: string | null;
};

/** `gh run list --json databaseId,headSha,status,conclusion,createdAt,url` 的输出；坏项略过，整体读不懂为 null。 */
export function parseRuns(stdout: string): ReleaseRun[] | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const runs: ReleaseRun[] = [];
  for (const item of value as Record<string, unknown>[]) {
    if (!item || typeof item !== "object") continue;
    const createdAt =
      typeof item.createdAt === "string" ? Date.parse(item.createdAt) : NaN;
    if (
      !Number.isSafeInteger(item.databaseId) ||
      typeof item.headSha !== "string" ||
      !/^[0-9a-f]{7,64}$/i.test(item.headSha) ||
      typeof item.status !== "string" ||
      !Number.isFinite(createdAt)
    )
      continue;
    runs.push({
      id: item.databaseId as number,
      sha: item.headSha.toLowerCase(),
      status: item.status,
      conclusion:
        typeof item.conclusion === "string" && item.conclusion
          ? item.conclusion
          : null,
      createdAt,
      url:
        typeof item.url === "string" && /^https:\/\//.test(item.url)
          ? item.url
          : null,
    });
  }
  return runs;
}

export type ReleaseVerdict =
  /** 还看不出来（没有运行、刚合入）：接着等。 */
  | { kind: "waiting" }
  /** 含它的发版正在排队或在跑。 */
  | { kind: "running"; run: ReleaseRun }
  /** 发版跑通了：标签随后就到。 */
  | { kind: "passed"; run: ReleaseRun }
  /** 含它的最近一次发版失败、被取消或超时，之后没有新的在跑。 */
  | { kind: "failed"; run: ReleaseRun }
  /** 合入 RELEASE_NO_RUN_MS 了还没有含它的发版运行。 */
  | { kind: "missing" };

const sameCommit = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x.startsWith(y) || y.startsWith(x);
};

/** 跑通或没跑（跳过、中性）的结论；其余结束的都算没发出来。 */
const PASSED = new Set(["success", "skipped", "neutral"]);

/**
 * 合入提交 commit 的发版怎样了（纯函数）：主干上合入之后触发的每次发版都含它——
 * 以它自己那次运行（headSha 相同）为起点，找不到就以合入时刻为起点，看这之后的运行：
 * 有在排队或在跑的就是在发；否则看最近一次的结论。
 */
export function releaseVerdict(input: {
  runs: readonly ReleaseRun[];
  commit: string;
  mergedAt: number;
  now: number;
}): ReleaseVerdict {
  const own = input.runs
    .filter((run) => sameCommit(run.sha, input.commit))
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)[0];
  const since = own ? own.createdAt : input.mergedAt;
  const after = input.runs.filter(
    (run) => run === own || run.createdAt >= since,
  );
  if (!after.length)
    return input.now - input.mergedAt >= RELEASE_NO_RUN_MS
      ? { kind: "missing" }
      : { kind: "waiting" };
  const active = after.find((run) => run.status !== "completed");
  if (active) return { kind: "running", run: active };
  const latest = [...after].sort(
    (a, b) => b.createdAt - a.createdAt || b.id - a.id,
  )[0]!;
  return PASSED.has(latest.conclusion ?? "")
    ? { kind: "passed", run: latest }
    : { kind: "failed", run: latest };
}

/** 挂在哪一步：`gh run view --json jobs` 里第一个没过的作业的第一个没过的步骤；读不出为 null。 */
export function failedStep(stdout: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  const jobs = (value as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(jobs)) return null;
  const bad = (item: unknown) => {
    const conclusion = (item as { conclusion?: unknown } | null)?.conclusion;
    return (
      typeof conclusion === "string" &&
      conclusion !== "" &&
      !PASSED.has(conclusion)
    );
  };
  for (const job of jobs as { name?: unknown; steps?: unknown }[]) {
    if (!bad(job)) continue;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const step = steps.find(bad) as { name?: unknown } | undefined;
    const name = typeof step?.name === "string" ? step.name.trim() : "";
    if (name) return name.replace(/^Run\s+/, "").slice(0, 120);
    if (typeof job.name === "string" && job.name.trim())
      return `作业 ${job.name.trim().slice(0, 80)}`;
  }
  return null;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/;

/**
 * `gh run view --log-failed` 的输出 → 失败用例与日志尾部摘要（纯函数）。
 * 每行是「作业\t步骤\t时间 内容」：去掉前两段、时间戳与颜色；摘要取最后 LOG_LINES 行非空行、至多 LOG_CHARS 字。
 */
export function logSummary(stdout: string): { tests: string[]; log: string } {
  const lines = stdout
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const parts = line.split("\t");
      const content = parts.length >= 3 ? parts.slice(2).join("\t") : line;
      return content.replace(STAMP, "").replace(ANSI, "").trimEnd();
    });
  const tests = failedTestNames(lines.join("\n"));
  const tail = lines.filter((line) => line.trim()).slice(-LOG_LINES);
  let log = tail.map((line) => line.slice(0, 200)).join("\n");
  if (log.length > LOG_CHARS) log = `…${log.slice(-(LOG_CHARS - 1))}`;
  return { tests, log };
}

const CONCLUSION_TEXT: Record<string, string> = {
  cancelled: "被取消",
  timed_out: "超时",
  startup_failure: "没能启动",
  action_required: "等人工批准",
  stale: "过期",
};

/**
 * 上线失败的一句话：「上线失败：发版工作流挂在 npm run check（失败用例：a、b）」。
 * short 是去掉「上线失败：」的那段，给看板一行用。
 */
export function releaseFailure(input: {
  verdict: Extract<ReleaseVerdict, { kind: "failed" | "missing" }>;
  step: string | null;
  tests: readonly string[];
}): { reason: string; short: string } {
  let short: string;
  if (input.verdict.kind === "missing")
    short = `合入 ${RELEASE_NO_RUN_MS / 60_000} 分钟还没有发版工作流在跑`;
  else {
    const how = CONCLUSION_TEXT[input.verdict.run.conclusion ?? ""];
    const where = input.step ?? "未知步骤";
    short = how
      ? `发版工作流${how}（${where}）`
      : `发版工作流挂在 ${where}${input.tests.length ? `（失败用例：${input.tests.slice(0, 3).join("、")}${input.tests.length > 3 ? ` 等 ${input.tests.length} 个` : ""}）` : ""}`;
  }
  return { reason: `上线失败：${short}`, short };
}

/** 合入太久没出版本（RELEASE_OVERDUE_MS）的一句话，同样按上线失败记。 */
export function overdueFailure(
  minutes: number,
  verdict: ReleaseVerdict | null,
) {
  const state =
    verdict?.kind === "running"
      ? "，发版工作流还在跑"
      : verdict?.kind === "passed"
        ? "，发版工作流跑通了但没有打出版本"
        : "";
  const short = `合入 ${minutes} 分钟仍没有含它的版本${state}`;
  return { reason: `上线失败：${short}；查看仓库的发版工作流`, short };
}
