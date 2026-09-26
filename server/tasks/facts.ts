import { exec as defaultExec, firstLine, type Exec } from "./git.ts";
import {
  addedFunctions,
  ciFromChecks,
  extractClaims,
  parseNumstat,
  type CheckedClaim,
  type Ci,
  type Facts,
  type Pr,
} from "./gates.ts";

/**
 * 执行者退出后运行时自己查事实（#262）：PR、CI、改动规模、是否收尾、摘要里的声明是否存在。
 * 只读调用 git / gh；查不到的记原因，交给关卡判定。
 */

export type FactInput = {
  repo: string | null;
  worktree: string | null;
  branch: string | null;
  base: string | null;
  summary: string;
};

export async function findPr(
  repo: string,
  branch: string,
  run: Exec = defaultExec,
): Promise<{ pr: Pr | null; error?: string }> {
  const listed = await run(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,url,state",
      "--limit",
      "1",
    ],
    { cwd: repo },
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
  // gh pr checks 在有失败或未出结果时退出码非 0，但 --json 输出照样完整，所以看输出不看退出码。
  const checks = await run("gh", [
    "pr",
    "checks",
    prUrl,
    "--json",
    "name,bucket",
  ]);
  let list: { name?: string; bucket?: string }[] | undefined;
  try {
    list = JSON.parse(checks.stdout) as { name?: string; bucket?: string }[];
  } catch {
    list = undefined;
  }
  if (!list)
    return { ci: null, detail: firstLine(checks.stderr) || "查不到检查" };
  const ci = ciFromChecks(list);
  const failing = list
    .filter((check) => check.bucket === "fail" || check.bucket === "cancel")
    .map((check) => check.name)
    .filter(Boolean);
  return {
    ci,
    detail: failing.length ? `失败的检查：${failing.join("、")}` : undefined,
  };
}

async function verifyClaims(
  repo: string,
  worktree: string,
  summary: string,
  run: Exec,
): Promise<CheckedClaim[]> {
  const checked: CheckedClaim[] = [];
  for (const claim of extractClaims(summary)) {
    if (claim.kind === "pr") {
      const view = await run(
        "gh",
        ["pr", "view", claim.value, "--json", "number"],
        { cwd: repo },
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
  const git = (...args: string[]) =>
    run("git", ["-C", worktree, ...args], { timeoutMs: 30_000 });
  const range = `origin/${base}...${branch}`;
  const [numstat, diff, status, ahead, head, remote, found] = await Promise.all(
    [
      git("diff", "--numstat", range),
      git("diff", "-U0", "--no-color", range),
      git("status", "--porcelain"),
      git("rev-list", "--count", `origin/${base}..${branch}`),
      git("rev-parse", branch),
      git("ls-remote", "origin", `refs/heads/${branch}`),
      findPr(repo, branch, run),
    ],
  );
  const facts: Facts = {
    ...empty,
    repo: true,
    branch,
    base,
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
  if (facts.pr) {
    const ci = await readCi(facts.pr.url, run);
    facts.ci = ci.ci;
    facts.ciDetail = ci.detail;
  }
  facts.claims = await verifyClaims(repo, worktree, input.summary, run);
  return facts;
}
