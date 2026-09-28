import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiArgs,
  originRepo,
  parsePrUrl,
  parseRemote,
  repoFlag,
} from "../server/tasks/gh-repo.ts";
import { collectFacts, readCi } from "../server/tasks/gates/facts.ts";
import { collectComments } from "../server/tasks/gates/comment-facts.ts";
import { evaluateGates } from "../server/tasks/gates/gates.ts";
import { exec, type Exec } from "../server/tasks/git.ts";
import { removeTemp } from "./temp-dir.ts";

test("origin 远端解析：https 与 ssh 写法都得到 owner/repo", () => {
  const fork = {
    host: "github.com",
    owner: "liu-zhengdong",
    name: "OpenQuota",
  };
  for (const url of [
    "https://github.com/liu-zhengdong/OpenQuota.git",
    "https://github.com/liu-zhengdong/OpenQuota",
    "https://github.com/liu-zhengdong/OpenQuota/",
    "https://token@github.com/liu-zhengdong/OpenQuota.git\n",
    "http://GitHub.com/liu-zhengdong/OpenQuota.git",
    "git@github.com:liu-zhengdong/OpenQuota.git",
    "github.com:liu-zhengdong/OpenQuota",
    "ssh://git@github.com/liu-zhengdong/OpenQuota.git",
    "ssh://git@github.com:22/liu-zhengdong/OpenQuota.git",
    "git://github.com/liu-zhengdong/OpenQuota.git",
  ])
    assert.deepEqual(parseRemote(url), fork, url);
  assert.deepEqual(parseRemote("git@ghe.example.com:team/app.git"), {
    host: "ghe.example.com",
    owner: "team",
    name: "app",
  });
});

test("origin 远端解析：本地路径与残缺地址不回落，返回 null", () => {
  for (const url of [
    "",
    "/tmp/x/origin.git",
    "./origin.git",
    "../origin",
    "file:///tmp/x/origin.git",
    "https://github.com/liu-zhengdong",
    "https://github.com/a/b/c",
    "git@github.com:/abs/path.git",
    "git@github.com:a/b/c.git",
    "https://github.com/a/../b",
    "https://github.com/a b/c",
    "C:/repo/origin.git",
  ])
    assert.equal(parseRemote(url), null, url);
});

test("PR 链接解析与 gh 参数写法", () => {
  const repo = parsePrUrl("https://github.com/liu-zhengdong/OpenQuota/pull/7");
  assert.deepEqual(repo, {
    host: "github.com",
    owner: "liu-zhengdong",
    name: "OpenQuota",
  });
  assert.equal(repoFlag(repo!), "liu-zhengdong/OpenQuota");
  assert.deepEqual(apiArgs(repo!, "issues/7/comments"), [
    "api",
    "repos/liu-zhengdong/OpenQuota/issues/7/comments",
  ]);
  const ghe = parsePrUrl("https://ghe.example.com/team/app/pull/3")!;
  assert.equal(repoFlag(ghe), "ghe.example.com/team/app");
  assert.deepEqual(apiArgs(ghe, "x"), [
    "api",
    "repos/team/app/x",
    "--hostname",
    "ghe.example.com",
  ]);
  assert.equal(parsePrUrl("https://github.com/o/r/issues/7"), null);
  assert.equal(parsePrUrl("not a url"), null);
});

test("PR 链接解析不出仓库时 CI 不查、明确报错", async () => {
  const result = await readCi("https://github.com/o/pull/1", async () => {
    throw new Error("不应调用 gh");
  });
  assert.equal(result.ci, null);
  assert.match(result.detail!, /解析不出 owner\/repo/);
});

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

/** fork 形态的假仓库：origin 指向 fork、另有 upstream；远端地址都不可达，只读 git 配置。 */
function forkRepo(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "atrium-fork-"));
  t.after(() => removeTemp(root));
  const repo = join(root, "openquota-fork");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(
    repo,
    "remote",
    "add",
    "origin",
    "git@github.com:liu-zhengdong/OpenQuota.git",
  );
  git(
    repo,
    "remote",
    "add",
    "upstream",
    "https://github.com/acme/OpenQuota.git",
  );
  git(repo, "checkout", "-qb", "task-t27-openquota");
  writeFileSync(join(repo, "b.txt"), "b\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "work");
  return repo;
}

/**
 * 真实 git + 假 gh：像 gh 在 fork 里那样，不带 -R 时落到上游（查不到 PR），
 * 带 -R liu-zhengdong/OpenQuota 才查到 fork 上的 PR #7。ls-remote 不连网，按本地 HEAD 作答。
 */
function forkExec(repo: string, calls: string[][]): Exec {
  const pr = {
    number: 7,
    url: "https://github.com/liu-zhengdong/OpenQuota/pull/7",
    state: "OPEN",
  };
  return async (command, args, options) => {
    if (command === "git" && args.includes("ls-remote")) {
      const head = git(repo, "rev-parse", "HEAD").trim();
      return {
        ok: true,
        stdout: `${head}\trefs/heads/task-t27-openquota\n`,
        stderr: "",
      };
    }
    if (command !== "gh") return exec(command, args, options);
    calls.push(args);
    const at = args.indexOf("-R");
    const target = at >= 0 ? args[at + 1] : "acme/OpenQuota";
    const onFork = target === "liu-zhengdong/OpenQuota";
    if (args[0] === "pr" && args[1] === "list")
      return {
        ok: true,
        stdout: JSON.stringify(onFork ? [pr] : []),
        stderr: "",
      };
    if (args[0] === "pr" && args[1] === "view")
      return onFork
        ? { ok: true, stdout: '{"number":7}', stderr: "" }
        : { ok: false, stdout: "", stderr: "no pull requests found" };
    if (args[0] === "pr" && args[1] === "checks")
      return {
        ok: true,
        stdout: JSON.stringify(
          onFork ? [{ name: "check", bucket: "pass", link: "" }] : [],
        ),
        stderr: "",
      };
    if (args[0] === "api")
      return {
        ok: true,
        stdout: JSON.stringify(
          args[1] === "repos/liu-zhengdong/OpenQuota/issues/7/comments"
            ? [[{ created_at: new Date().toISOString(), html_url: pr.url }]]
            : [[]],
        ),
        stderr: "",
      };
    return {
      ok: false,
      stdout: "",
      stderr: `未预期的 gh 调用：${args.join(" ")}`,
    };
  };
}

test("fork 形态仓库：PR、CI、声明核对与评论都查 origin 而不是上游", async (t) => {
  const repo = forkRepo(t);
  assert.deepEqual(await originRepo(repo), {
    repo: { host: "github.com", owner: "liu-zhengdong", name: "OpenQuota" },
  });
  const calls: string[][] = [];
  const run = forkExec(repo, calls);
  const facts = await collectFacts(
    {
      repo,
      worktree: repo,
      branch: "task-t27-openquota",
      base: "main",
      summary: "已开 PR #7",
    },
    run,
  );
  assert.equal(facts.ghRepo, "liu-zhengdong/OpenQuota");
  assert.equal(facts.pr?.number, 7);
  assert.equal(facts.ci, "success");
  assert.equal(facts.pushed, true);
  assert.deepEqual(
    facts.claims.map((claim) => claim.ok),
    [true],
  );
  const verdict = evaluateGates(
    ["pr_exists", "ci", "claims_verified"],
    {},
    facts,
  );
  assert.equal(verdict.passed, true, JSON.stringify(verdict.results));
  // 每个 gh 调用都显式指定了 fork：pr 子命令带 -R，api 路径写全。
  for (const args of calls) {
    if (args[0] === "pr") {
      const at = args.indexOf("-R");
      assert.ok(at > 0, args.join(" "));
      assert.equal(args[at + 1], "liu-zhengdong/OpenQuota");
    } else assert.match(args[1]!, /^repos\/liu-zhengdong\/OpenQuota\//);
  }
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2).join(" ")),
    ["pr list", "pr checks", "pr view"],
  );

  const optionalCalls: string[][] = [];
  const withoutCi = await collectFacts(
    {
      repo,
      worktree: repo,
      branch: "task-t27-openquota",
      base: "main",
      summary: "",
    },
    forkExec(repo, optionalCalls),
    false,
  );
  assert.equal(withoutCi.pr?.number, 7);
  assert.equal(withoutCi.ci, null);
  assert.deepEqual(
    optionalCalls.map((args) => args.slice(0, 2).join(" ")),
    ["pr list"],
  );

  const comments = await collectComments(repo, 7, Date.now() - 60_000, run);
  assert.equal(comments.error, undefined);
  assert.equal(comments.comments.length, 1);
  assert.equal(
    calls.at(-1)![1],
    "repos/liu-zhengdong/OpenQuota/issues/7/comments",
  );
});

test("origin 不是 GitHub 地址时明确报错，不回落到 gh 默认", async (t) => {
  const repo = forkRepo(t);
  git(repo, "remote", "set-url", "origin", "/srv/git/openquota.git");
  const calls: string[][] = [];
  const run = forkExec(repo, calls);
  const facts = await collectFacts(
    {
      repo,
      worktree: repo,
      branch: "task-t27-openquota",
      base: "main",
      summary: "已开 PR #7",
    },
    run,
  );
  assert.equal(facts.pr, null);
  assert.equal(facts.ghRepo, undefined);
  assert.match(
    facts.prError!,
    /origin 远端 \/srv\/git\/openquota\.git 解析不出 owner\/repo/,
  );
  assert.equal(facts.claims[0]?.ok, false);
  assert.match(facts.claims[0]!.detail!, /解析不出/);
  const comments = await collectComments(repo, 7, Date.now(), run);
  assert.match(comments.error!, /解析不出/);
  git(repo, "remote", "remove", "origin");
  const missing = await collectComments(repo, 7, Date.now(), run);
  assert.match(missing.error!, /读不到仓库 .* 的 origin 远端/);
  assert.deepEqual(calls, []);
});
