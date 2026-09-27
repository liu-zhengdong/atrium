import { exec as defaultExec, firstLine, type Exec } from "./git.ts";
import {
  addedFunctions,
  extractClaims,
  parseNumstat,
  type CheckedClaim,
  type Ci,
  type Facts,
  type Pr,
} from "./gates.ts";
import {
  actionJob,
  classifyCi,
  type Annotation,
  type Check,
  type Job,
  type Observation,
} from "./ci-classify.ts";
import {
  apiArgs,
  originRepo,
  parsePrUrl,
  repoFlag,
  type GhRepo,
} from "./gh-repo.ts";
import { readScreenshots } from "./screenshot-facts.ts";

/**
 * 执行者退出后运行时自己查事实（#262）：PR、CI、改动规模、是否收尾、摘要里的声明是否存在。
 * 只读调用 git / gh；查不到的记原因，交给关卡判定。
 * gh 一律显式指定仓库（见 gh-repo.ts），fork 里不落到上游。
 */

export type FactInput = {
  repo: string | null;
  worktree: string | null;
  branch: string | null;
  base: string | null;
  summary: string;
};

export async function findPr(
  target: GhRepo,
  branch: string,
  run: Exec = defaultExec,
): Promise<{ pr: Pr | null; error?: string }> {
  const listed = await run(
    "gh",
    [
      "pr",
      "list",
      "-R",
      repoFlag(target),
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,url,state,body",
      "--limit",
      "1",
    ],
    { timeoutMs: 30_000 },
  );
  if (!listed.ok) return { pr: null, error: firstLine(listed.stderr) };
  try {
    const [pr] = JSON.parse(listed.stdout) as Pr[];
    return { pr: pr ?? null };
  } catch {
    return { pr: null, error: "gh 输出不是 JSON" };
  }
}

export async function readCi(
  prUrl: string,
  run: Exec = defaultExec,
): Promise<{ ci: Ci | null; detail?: string }> {
  const target = parsePrUrl(prUrl);
  if (!target)
    return { ci: null, detail: `PR 链接 ${prUrl} 解析不出 owner/repo` };
  // gh pr checks 在有失败或未出结果时退出码非 0，但 --json 输出照样完整，所以看输出不看退出码。
  const checks = await run("gh", [
    "pr",
    "checks",
    prUrl,
    "-R",
    repoFlag(target),
    "--json",
    "name,bucket,link",
  ]);
  let list: Check[] | undefined;
  try {
    const parsed: unknown = JSON.parse(checks.stdout);
    if (Array.isArray(parsed)) list = parsed as Check[];
  } catch {
    list = undefined;
  }
  if (!list)
    return { ci: null, detail: firstLine(checks.stderr) || "查不到检查" };
  const failing = list.filter(
    (check) => check.bucket === "fail" || check.bucket === "cancel",
  );
  const jobs = new Map<string, Job[]>();
  const observations: Observation[] = [];
  for (const check of failing) {
    const action = actionJob(check.link);
    if (!action) continue;
    const runKey = `${action.repo}/${action.run}`;
    // Actions 链接里的 owner/repo 就是跑 CI 的仓库，路径写全，不靠 gh 解析本地远端。
    const actions: GhRepo = {
      ...target,
      owner: action.repo.split("/")[0]!,
      name: action.repo.split("/")[1]!,
    };
    if (!jobs.has(runKey)) {
      const response = await run(
        "gh",
        apiArgs(actions, `actions/runs/${action.run}/jobs?per_page=100`),
      );
      let listed: Job[] = [];
      if (response.ok) {
        try {
          const parsed: unknown = JSON.parse(response.stdout);
          if (
            parsed &&
            typeof parsed === "object" &&
            "jobs" in parsed &&
            Array.isArray(parsed.jobs)
          )
            listed = parsed.jobs as Job[];
        } catch {
          // 查不到 job 时沿用普通失败，不能把未知状态判成未运行。
        }
      }
      jobs.set(runKey, listed);
    }
    const job = jobs.get(runKey)?.find((entry) => entry.id === action.job);
    const annotations = await run(
      "gh",
      apiArgs(actions, `check-runs/${action.job}/annotations?per_page=100`),
    );
    let parsedAnnotations: Annotation[] = [];
    if (annotations.ok) {
      try {
        const parsed: unknown = JSON.parse(annotations.stdout);
        if (Array.isArray(parsed)) parsedAnnotations = parsed as Annotation[];
      } catch {
        // 注解不可读时仅按 job 步骤判定。
      }
    }
    observations.push({ check, job, annotations: parsedAnnotations });
  }
  return classifyCi(list, observations);
}

async function verifyClaims(
  target: GhRepo | { error: string },
  worktree: string,
  summary: string,
  run: Exec,
): Promise<CheckedClaim[]> {
  const checked: CheckedClaim[] = [];
  for (const claim of extractClaims(summary)) {
    if (claim.kind === "pr") {
      if ("error" in target) {
        checked.push({ ...claim, ok: false, detail: target.error });
        continue;
      }
      const view = await run(
        "gh",
        ["pr", "view", claim.value, "-R", repoFlag(target), "--json", "number"],
        { timeoutMs: 30_000 },
      );
      checked.push({
        ...claim,
        ok: view.ok,
        detail: view.ok ? undefined : firstLine(view.stderr),
      });
    } else {
      const found = await run(
        "git",
        ["-C", worktree, "cat-file", "-e", `${claim.value}^{commit}`],
        { timeoutMs: 10_000 },
      );
      checked.push({
        ...claim,
        ok: found.ok,
        detail: found.ok ? undefined : "仓库里没有这个提交",
      });
    }
  }
  return checked;
}

export async function collectFacts(
  input: FactInput,
  run: Exec = defaultExec,
  includeCi = true,
  includeScreenshots = false,
): Promise<Facts> {
  const empty: Facts = {
    repo: false,
    pr: null,
    ci: null,
    numstat: [],
    functions: [],
    dirty: [],
    ahead: 0,
    pushed: null,
    claims: [],
  };
  const { repo, worktree, branch, base } = input;
  if (!repo || !worktree || !branch || !base) return empty;
  // 只读查询不拿可选锁，不和工作树里其他 git 进程抢 index.lock（见 watchdog 的探测）。
  const git = (...args: string[]) =>
    run("git", ["--no-optional-locks", "-C", worktree, ...args], {
      timeoutMs: 30_000,
    });
  const range = `origin/${base}...${branch}`;
  const origin = await originRepo(repo, run);
  const target = "error" in origin ? origin : origin.repo;
  const [numstat, diff, status, ahead, head, remote, found] = await Promise.all(
    [
      git("diff", "--numstat", range),
      git("diff", "-U0", "--no-color", range),
      git("status", "--porcelain"),
      git("rev-list", "--count", `origin/${base}..${branch}`),
      git("rev-parse", branch),
      git("ls-remote", "origin", `refs/heads/${branch}`),
      "error" in target
        ? Promise.resolve({ pr: null, error: target.error })
        : findPr(target, branch, run),
    ],
  );
  const facts: Facts = {
    ...empty,
    repo: true,
    branch,
    base,
    ghRepo: "error" in target ? undefined : repoFlag(target),
    pr: found.pr,
    prError: found.error,
    numstat: numstat.ok ? parseNumstat(numstat.stdout) : [],
    functions: diff.ok ? addedFunctions(diff.stdout) : [],
    dirty: status.ok
      ? status.stdout
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => line.slice(3))
      : [],
    ahead: ahead.ok ? Number(ahead.stdout.trim()) || 0 : 0,
  };
  if (!remote.ok) {
    facts.pushed = null;
    facts.pushDetail = firstLine(remote.stderr);
  } else {
    const remoteSha = remote.stdout.trim().split(/\s+/)[0] ?? "";
    facts.pushed = !!remoteSha && remoteSha === head.stdout.trim();
    if (!remoteSha) facts.pushDetail = `origin 上没有分支 ${branch}`;
    else if (!facts.pushed) facts.pushDetail = "origin 上的分支落后于本地";
  }
  if (facts.pr && includeCi) {
    const ci = await readCi(facts.pr.url, run);
    facts.ci = ci.ci;
    facts.ciDetail = ci.detail;
  }
  if (facts.pr && includeScreenshots)
    facts.screenshots = await readScreenshots(facts.pr.body ?? "");
  facts.claims = await verifyClaims(target, worktree, input.summary, run);
  return facts;
}
