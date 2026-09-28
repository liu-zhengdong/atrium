import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { CheckRequest } from "../server/hosts/check-runtime.ts";
import { exec, type Exec } from "../server/tasks/git.ts";
import { getTask } from "../server/tasks/ledger.ts";
import { ensureTaskTables } from "../server/tasks/ledger-schema.ts";
import type { LocalCheck } from "../server/tasks/local-check.ts";
import { MergeQueue } from "../server/tasks/merge-runtime.ts";
import { removeTemp } from "./temp-dir.ts";

/**
 * 合入队列的提前检查（t254）：真 git 仓库（本地裸仓库当 origin），假 gh（squash 合入在一个辅助克隆里做），
 * 假检查（记下检查了哪个任务的哪个提交，队首的检查等测试放行）。
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const LINES = Array.from({ length: 20 }, (_, i) => `line ${i}`);

type Scenario = {
  /** 第二件改哪个文件的哪一行（第一件改 a.txt 第 0 行）。 */
  second: { file: string; line: number };
  /** 第二件的检查结果（提前检查与重跑都用它）。 */
  secondCheck?: "passed" | "failed";
  /** 第一件的检查结果。 */
  firstCheck?: "passed" | "failed";
  /** 第二件第一次 gh 合入被拒。 */
  rejectOnce?: boolean;
  /** 第二件的提前检查一直跑到队首轮到它（队首接手在跑的提前检查）。 */
  holdSecond?: boolean;
};

async function runQueue(t: TestContext, scenario: Scenario) {
  const root = mkdtempSync(join(tmpdir(), "atrium-precheck-"));
  t.after(() => removeTemp(root));
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const repo = join(root, "repo");
  git(root, "clone", "-q", origin, repo);
  for (const dir of [repo]) {
    git(dir, "config", "user.name", "test");
    git(dir, "config", "user.email", "test@example.com");
  }
  git(repo, "checkout", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), `${LINES.join("\n")}\n`);
  writeFileSync(join(repo, "b.txt"), "b\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "基础");
  git(repo, "push", "-q", "-u", "origin", "main");
  const worktree = (n: number, file: string, line: number) => {
    const path = join(root, `wt${n}`);
    git(repo, "worktree", "add", "-q", "-b", `task-${n}`, path, "origin/main");
    const target = join(path, file);
    if (file === "a.txt") {
      const lines = [...LINES];
      lines[line] = `task ${n}`;
      writeFileSync(target, `${lines.join("\n")}\n`);
    } else writeFileSync(target, `task ${n}\n`);
    git(path, "add", ".");
    git(path, "commit", "-qm", `任务 ${n}`);
    git(path, "push", "-q", "-u", "origin", `task-${n}`);
    return path;
  };
  const worktrees = [
    worktree(1, "a.txt", 0),
    worktree(2, scenario.second.file, scenario.second.line),
  ];
  // GitHub 那边的 squash 合入。
  const hub = join(root, "hub");
  git(root, "clone", "-q", origin, hub);
  git(hub, "config", "user.name", "hub");
  git(hub, "config", "user.email", "hub@example.com");
  const remoteHead = (branch: string) =>
    git(root, "--git-dir", origin, "rev-parse", `refs/heads/${branch}`);
  const merged = new Map<number, string>();
  const merges: { task: number; head: string }[] = [];
  let rejected = false;
  const run: Exec = async (command, args, options) => {
    if (command === "git" && args.includes("get-url"))
      return {
        ok: true,
        stdout: "https://github.com/acme/demo.git\n",
        stderr: "",
      };
    if (command !== "gh") return exec(command, args, options);
    const n = Number(args[2]!.split("/").at(-1));
    const branch = `task-${n}`;
    if (args[1] === "view")
      return {
        ok: true,
        stdout: JSON.stringify({
          state: merged.has(n) ? "MERGED" : "OPEN",
          headRefOid: remoteHead(branch),
          headRefName: branch,
          baseRefName: "main",
          isCrossRepository: false,
          mergeCommit: merged.has(n) ? { oid: merged.get(n) } : null,
        }),
        stderr: "",
      };
    if (args[1] === "merge") {
      const head = args[args.indexOf("--match-head-commit") + 1]!;
      merges.push({ task: n, head });
      if (head !== remoteHead(branch))
        return { ok: false, stdout: "", stderr: "head 不符" };
      if (scenario.rejectOnce && n === 2 && !rejected) {
        rejected = true;
        return {
          ok: false,
          stdout: "",
          stderr: "Head branch is out of date. Review and try again.",
        };
      }
      git(hub, "fetch", "-q", "origin");
      git(hub, "checkout", "-q", "-B", "main", "origin/main");
      git(hub, "merge", "-q", "--squash", `origin/${branch}`);
      git(hub, "commit", "-qm", `合入 #${n}`);
      git(hub, "push", "-q", "origin", "main");
      merged.set(n, git(hub, "rev-parse", "HEAD"));
      return { ok: true, stdout: "", stderr: "" };
    }
    return { ok: false, stdout: "", stderr: `unexpected gh ${args[1]}` };
  };
  let release!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const ran: { task: number; head: string }[] = [];
  const checks = {
    async run(request: CheckRequest): Promise<LocalCheck> {
      const head = git(request.worktree, "rev-parse", "HEAD");
      ran.push({ task: request.task, head });
      request.onStatus?.("started", join(request.taskDir, "log"), "h1");
      const first = ran.filter((r) => r.task === request.task).length === 1;
      const gate =
        request.task === 1
          ? firstGate
          : scenario.holdSecond
            ? secondGate
            : null;
      if (first && gate)
        await Promise.race([
          gate,
          new Promise((resolve) =>
            request.signal?.addEventListener("abort", resolve),
          ),
        ]);
      const outcome =
        (request.task === 1 ? scenario.firstCheck : scenario.secondCheck) ??
        "passed";
      return {
        status: outcome,
        command: "fake",
        log: join(request.taskDir, "log"),
        detail: outcome === "passed" ? "检查通过" : "退出码 1",
        failedTests: outcome === "passed" ? [] : ["故意失败"],
        host: "h1",
        commit: head,
      };
    },
  };
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const insert = db.prepare(
    "INSERT INTO tasks(title,deliver,status,delivery_stage,merge_queued_at,repo,worktree,branch,pr_url,worker,created_at,updated_at) VALUES (?,'pr','done','merge_queued',?,?,?,?,?,'kimi',1,1)",
  );
  for (const n of [1, 2])
    insert.run(
      `任务 ${n}`,
      n,
      repo,
      worktrees[n - 1]!,
      `task-${n}`,
      `https://github.com/acme/demo/pull/${n}`,
    );
  const queue = new MergeQueue(db, {
    data: join(root, "data"),
    env: {},
    run,
    returned: async () => {},
    publish: () => {},
    changed: () => {},
    checks,
    prechecks: () => 1,
    prHeadWaitMs: 2_000,
  });
  t.after(() => queue.close());
  const kinds = (id: number) =>
    (
      db
        .prepare("SELECT kind FROM task_events WHERE task_id=? ORDER BY id")
        .all(id) as { kind: string }[]
    ).map((row) => row.kind);
  const until = async (what: string, ok: () => boolean) => {
    const deadline = Date.now() + 30_000;
    while (!ok()) {
      assert.ok(Date.now() < deadline, `等待超时：${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  queue.kick();
  // 队首的检查还卡着，第二件已经提前检查完（或正在提前检查）。
  await until("第二件提前检查", () =>
    kinds(2).includes(
      scenario.holdSecond ? "merge_precheck_started" : "merge_prechecked",
    ),
  );
  assert.equal(getTask(db, 1).delivery_stage, "merging");
  assert.equal(getTask(db, 2).delivery_stage, "merge_queued");
  release();
  if (scenario.holdSecond) {
    // 队首轮到第二件时它的提前检查还在跑：接着等，不另起一遍。
    await until("队首轮到第二件", () => kinds(2).includes("merge_started"));
    assert.equal(kinds(2).includes("merge_prechecked"), false);
    releaseSecond();
  }
  const settled = (id: number) => {
    const task = getTask(db, id);
    return task.delivery_stage === "merged" || task.status === "blocked";
  };
  await until("两件都有结局", () => settled(1) && settled(2));
  const event = (id: number, kind: string) => {
    const row = db
      .prepare(
        "SELECT detail FROM task_events WHERE task_id=? AND kind=? ORDER BY id DESC LIMIT 1",
      )
      .get(id, kind) as { detail: string } | undefined;
    return row ? (JSON.parse(row.detail) as Record<string, unknown>) : null;
  };
  // 每件检查了哪些提交（提前检查与队首的检查并行，先后不定）。
  const checked = (id: number) =>
    ran.filter((item) => item.task === id).map((item) => item.head);
  return { db, merges, kinds, event, checked, remoteHead };
}

test("提前检查：main 只前进了不相干的文件，直接按检查过的提交合入，不重跑", async (t) => {
  const r = await runQueue(t, { second: { file: "b.txt", line: 0 } });
  assert.equal(getTask(r.db, 1).delivery_stage, "merged");
  assert.equal(getTask(r.db, 2).delivery_stage, "merged");
  // 两件各检查一次：第二件用的是提前检查的结果。
  assert.equal(r.checked(1).length, 1);
  assert.equal(r.checked(2).length, 1);
  const prechecked = r.event(2, "merge_prechecked")!;
  assert.equal(prechecked.outcome, "passed");
  const reused = r.event(2, "merge_check")!;
  assert.match(String(reused.reused), /不相干的改动（1 个文件）/);
  assert.notEqual(reused.main, prechecked.base, "main 在提前检查之后前进了");
  // 按检查过的那个提交合入。
  assert.deepEqual(r.merges.at(-1), { task: 2, head: r.checked(2)[0] });
  assert.equal(r.kinds(2).includes("merge_precheck_unused"), false);
});

test("提前检查：队首轮到它时提前检查还在跑，等它跑完直接用结果", async (t) => {
  const r = await runQueue(t, {
    second: { file: "b.txt", line: 0 },
    holdSecond: true,
  });
  assert.equal(getTask(r.db, 2).delivery_stage, "merged");
  assert.equal(r.checked(2).length, 1);
  assert.match(String(r.event(2, "merge_check")!.reused), /不相干的改动/);
  assert.deepEqual(r.merges.at(-1), { task: 2, head: r.checked(2)[0] });
});

test("提前检查：main 改了同一个文件，rebase 到最新 main 重跑检查再合入", async (t) => {
  const r = await runQueue(t, { second: { file: "a.txt", line: 19 } });
  assert.equal(getTask(r.db, 2).delivery_stage, "merged");
  assert.equal(r.checked(1).length, 1);
  const [early, again] = r.checked(2);
  assert.equal(r.checked(2).length, 2);
  assert.notEqual(again, early, "重跑的是 rebase 后的提交");
  assert.match(
    String(r.event(2, "merge_precheck_unused")!.reason),
    /main 改了同一批文件：a\.txt/,
  );
  assert.deepEqual(r.merges.at(-1), { task: 2, head: again });
});

test("提前检查：复用结果合入被 GitHub 拒了，回头 rebase 重跑再合入", async (t) => {
  const r = await runQueue(t, {
    second: { file: "b.txt", line: 0 },
    rejectOnce: true,
  });
  assert.equal(getTask(r.db, 2).delivery_stage, "merged");
  assert.equal(getTask(r.db, 2).merge_returns, 0, "不算交回执行者");
  const [early, again] = r.checked(2);
  assert.equal(r.checked(2).length, 2);
  assert.match(
    String(r.event(2, "merge_reuse_rejected")!.reason),
    /out of date/,
  );
  assert.deepEqual(
    r.merges.filter((m) => m.task === 2).map((m) => m.head),
    [early, again],
  );
  assert.equal(r.remoteHead("task-2"), again);
});

test("提前检查没过、main 也没动：轮到它时直接交回，不再跑一遍", async (t) => {
  const r = await runQueue(t, {
    second: { file: "b.txt", line: 0 },
    firstCheck: "failed",
    secondCheck: "failed",
  });
  // 第一件没过交回，main 没动；第二件用提前检查的结果交回。
  assert.equal(getTask(r.db, 1).merge_returns, 1);
  assert.equal(getTask(r.db, 2).merge_returns, 1);
  assert.equal(getTask(r.db, 2).status, "blocked");
  assert.equal(r.checked(1).length, 1);
  assert.equal(r.checked(2).length, 1);
  assert.equal(r.merges.length, 0);
  assert.match(
    String(r.event(2, "merge_check")!.reused),
    /提前检查没过，main 之后没动/,
  );
  assert.match(
    String(r.event(2, "merge_returned")!.reason),
    /本地检查failed：故意失败/,
  );
});
