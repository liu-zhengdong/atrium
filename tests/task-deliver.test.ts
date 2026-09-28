import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { exec, type Exec } from "../server/tasks/git.ts";
import { ensureTaskTables } from "../server/tasks/ledger-schema.ts";
import { MergeQueue } from "../server/tasks/merge-runtime.ts";
import {
  parseWorktrees,
  prRefusal,
  registerRefusal,
  worktreeChoice,
  type WorktreeEntry,
} from "../server/tasks/register-delivery.ts";
import { TASK_STATUSES } from "../server/tasks/state.ts";
import { startApp } from "./task-fixture.ts";
import { TRUE_COMMAND } from "./portable-shell.ts";

test("git worktree list --porcelain：主工作树在前，分离头没有分支，CRLF 也认", () => {
  const text = [
    "worktree /repo",
    "HEAD aaa",
    "branch refs/heads/main",
    "",
    "worktree /repo-fix",
    "HEAD bbb",
    "branch refs/heads/fix",
    "",
    "worktree /repo-detached",
    "HEAD ccc",
    "detached",
    "",
  ].join("\r\n");
  assert.deepEqual(parseWorktrees(text), [
    { path: "/repo", head: "aaa", branch: "main" },
    { path: "/repo-fix", head: "bbb", branch: "fix" },
    { path: "/repo-detached", head: "ccc", branch: null },
  ]);
  assert.deepEqual(parseWorktrees(""), []);
});

test("登记交付：任务状态与合入阶段穷举", () => {
  const stages = [
    null,
    "reviewing",
    "merge_queued",
    "merging",
    "merged",
    "online",
  ] as const;
  for (const status of TASK_STATUSES)
    for (const stage of stages) {
      const refused = registerRefusal({
        ref: "t9",
        status,
        delivery_stage: stage,
      });
      const open =
        status !== "running" && status !== "cancelled" && stage === null;
      assert.equal(refused === null, open, `${status}/${stage}：${refused}`);
    }
  assert.match(
    registerRefusal({ ref: "t9", status: "running", delivery_stage: null })!,
    /atrium task stop t9/,
  );
});

test("登记交付：PR 的状态、来源与目标分支", () => {
  const pr = {
    state: "OPEN",
    headRefName: "fix",
    headRefOid: "abc",
    baseRefName: "main",
    isCrossRepository: false,
  };
  assert.equal(prRefusal(pr, "main"), null);
  assert.match(prRefusal({ ...pr, state: "MERGED" }, "main")!, /已合入/);
  assert.match(prRefusal({ ...pr, state: "CLOSED" }, "main")!, /CLOSED/);
  assert.match(
    prRefusal({ ...pr, isCrossRepository: true }, "main")!,
    /不是仓库 origin 的分支/,
  );
  assert.match(prRefusal({ ...pr, baseRefName: "dev" }, "main")!, /dev/);
});

test("登记交付：合入用哪个工作树", () => {
  const main: WorktreeEntry = { path: "/repo", head: "m", branch: "main" };
  const fix: WorktreeEntry = { path: "/repo-fix", head: "abc", branch: "fix" };
  const base = {
    platform: "linux" as const,
    ref: "t9",
    given: null,
    own: null,
    pr: { headRefName: "fix", headRefOid: "abc" },
    worktrees: [main, fix],
    copy: { path: "/repo-t9-fix", exists: false },
  };
  // 给了：须是附属工作树、在 PR 分支、头提交一致。
  assert.deepEqual(worktreeChoice({ ...base, given: "/repo-fix/" }), {
    worktree: "/repo-fix",
  });
  assert.match(
    (worktreeChoice({ ...base, given: "/elsewhere" }) as { error: string })
      .error,
    /不是任务仓库的工作树/,
  );
  assert.match(
    (worktreeChoice({ ...base, given: "/repo" }) as { error: string }).error,
    /主工作树/,
  );
  assert.match(
    (
      worktreeChoice({
        ...base,
        given: "/repo-fix",
        worktrees: [main, { ...fix, branch: "other" }],
      }) as { error: string }
    ).error,
    /分支 other 上/,
  );
  assert.match(
    (
      worktreeChoice({
        ...base,
        given: "/repo-fix",
        worktrees: [main, { ...fix, head: "old" }],
      }) as { error: string }
    ).error,
    /先推送或拉齐/,
  );
  // 没给：分支没检出由合入队列另建；另建的路径被占了请调用方处理。
  assert.deepEqual(worktreeChoice({ ...base, worktrees: [main] }), {
    worktree: null,
  });
  assert.match(
    (
      worktreeChoice({
        ...base,
        worktrees: [main],
        copy: { path: "/repo-t9-fix", exists: true },
      }) as { error: string }
    ).error,
    /已被占用/,
  );
  // 分支检出在任务自己的工作树上：用它；在别处：请明说；在主工作树：先切走。
  assert.deepEqual(worktreeChoice({ ...base, own: "/repo-fix" }), {
    worktree: "/repo-fix",
  });
  assert.match(
    (worktreeChoice(base) as { error: string }).error,
    /加 --worktree \/repo-fix/,
  );
  assert.match(
    (
      worktreeChoice({
        ...base,
        worktrees: [{ ...main, branch: "fix", head: "abc" }],
      }) as { error: string }
    ).error,
    /主工作树上：先切走/,
  );
  // Windows 路径大小写与分隔符不同也认同一个。
  assert.deepEqual(
    worktreeChoice({
      ...base,
      platform: "win32",
      given: "c:\\Repo-Fix",
      worktrees: [main, { ...fix, path: "C:/repo-fix" }],
    }),
    { worktree: "C:/repo-fix" },
  );
});

test("登记交付过的受阻任务可用 task merge 重新排队，没建工作树也行", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  db.prepare(
    "INSERT INTO tasks(title,deliver,status,repo,branch,pr_url,created_at,updated_at) VALUES ('秘书修的','pr','blocked','/repo','fix','https://github.com/acme/demo/pull/1',1,1)",
  ).run();
  for (const kind of ["delivery_registered", "merge_queued", "merge_blocked"])
    db.prepare(
      "INSERT INTO task_events(task_id,at,kind,detail) VALUES (1,1,?,'{}')",
    ).run(kind);
  const queue = new MergeQueue(db, {
    data: "/unused",
    env: {},
    run: async () => ({ ok: false, stdout: "", stderr: "unused" }),
    returned: async () => {},
    publish: () => {},
    changed: () => {},
  });
  // 队列一启动就会去查 origin（假命令失败），这里只看排队本身。
  const task = queue.requeue(1);
  assert.equal(task.status, "done");
  assert.ok(
    task.delivery_stage === "merge_queued" || task.delivery_stage === "merging",
  );
  await queue.close();
  db.close();
});

for (const scenario of ["given", "built"] as const) {
  test(`隔离服务：秘书亲自改完登记交付后合入（${scenario === "given" ? "给工作树" : "合入队列另建"}）`, async (t) => {
    let merged = false;
    let mergeCalls = 0;
    const branch = "fix-by-secretary";
    let origin = "";
    const { fx, call } = await startApp(t, (fixture) => {
      origin = join(fixture.root, "origin.git");
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: fixture.repo,
          encoding: "utf8",
        }).trim();
      git("config", "user.name", "test");
      git("config", "user.email", "test@example.com");
      writeFileSync(
        join(fixture.repo, "package.json"),
        JSON.stringify({ scripts: { check: TRUE_COMMAND } }),
      );
      git("add", ".");
      git("commit", "-qm", "检查夹具");
      git("push", "-q", "origin", "main");
      const remoteHead = () =>
        execFileSync(
          "git",
          ["--git-dir", origin, "rev-parse", `refs/heads/${branch}`],
          { encoding: "utf8" },
        ).trim();
      const fake: Exec = async (command, args, options) => {
        if (command === "git" && args.includes("get-url"))
          return {
            ok: true,
            stdout: "https://github.com/acme/demo.git\n",
            stderr: "",
          };
        if (command !== "gh") return exec(command, args, options);
        assert.equal(args[args.indexOf("-R") + 1], "acme/demo");
        if (args[0] === "pr" && args[1] === "view")
          return {
            ok: true,
            stdout: JSON.stringify({
              state: merged ? "MERGED" : "OPEN",
              headRefOid: remoteHead(),
              headRefName: branch,
              baseRefName: "main",
              isCrossRepository: false,
            }),
            stderr: "",
          };
        if (args[0] === "pr" && args[1] === "merge") {
          mergeCalls++;
          merged = true;
          return { ok: true, stdout: "merged", stderr: "" };
        }
        return {
          ok: false,
          stdout: "",
          stderr: `unexpected gh ${args.join(" ")}`,
        };
      };
      fixture.run = fake;
    });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    // 秘书在自己的工作树改完、推送、开 PR。
    const own = join(fx.root, "secretary-tree");
    git(fx.repo, "worktree", "add", "-q", "-b", branch, own, "main");
    writeFileSync(join(own, "fix.txt"), "fixed\n");
    git(own, "add", "fix.txt");
    git(own, "commit", "-qm", "紧急修复");
    git(own, "push", "-q", "origin", branch);
    const created = await call("POST", "/api/tasks", {
      title: "秘书的紧急修复",
      repo: fx.repo,
    });
    assert.equal(created.status, 201);
    const ref = created.body.ref as string;
    const url = "https://github.com/acme/demo/pull/7";

    // 破坏输入：链接不对、路径不是绝对路径、PR 不在仓库 origin 上。
    const bad = async (body: object, status: number, pattern: RegExp) => {
      const result = await call("POST", `/api/tasks/${ref}/deliver`, body);
      assert.equal(result.status, status, JSON.stringify(result.body));
      assert.match(result.body.error, pattern);
    };
    await bad({ pr_url: "not-a-url" }, 400, /--pr/);
    await bad({ pr_url: url, worktree: "relative/tree" }, 400, /--worktree/);
    await bad(
      { pr_url: "https://github.com/acme/other/pull/7" },
      409,
      /不在仓库 origin/,
    );
    await bad({ pr_url: url, oops: 1 }, 400, /不认识的字段/);

    if (scenario === "built") {
      // 分支还检出在秘书的工作树上：不给 --worktree 会被请明说。
      await bad({ pr_url: url }, 409, /加 --worktree/);
      git(fx.repo, "worktree", "remove", own);
    }
    const delivered = await call(
      "POST",
      `/api/tasks/${ref}/deliver`,
      scenario === "given" ? { pr_url: url, worktree: own } : { pr_url: url },
    );
    assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
    assert.equal(delivered.body.task.status, "done");
    assert.equal(delivered.body.task.branch, branch);
    // 已进合入队列：再登记被拒。
    await bad({ pr_url: url }, 409, /已在合入队列|已合入/);

    const waited = await call("GET", `/api/tasks/${ref}/wait?timeout=30`);
    assert.equal(waited.status, 200);
    const task = waited.body.task;
    assert.equal(task.delivery_stage, "merged", JSON.stringify(task.events));
    assert.equal(mergeCalls, 1);
    const kinds = task.events.map((event: { kind: string }) => event.kind);
    assert.ok(kinds.includes("delivery_registered"));
    assert.ok(kinds.includes("merge_check"));
    const registered = task.events.find(
      (event: { kind: string }) => event.kind === "delivery_registered",
    );
    assert.equal(JSON.parse(registered.detail).by, "secretary");
    // 合入在哪个工作树做（给的，或按工作树规则另建的），合入后就和执行者的一样清理哪个。
    const tree = scenario === "given" ? own : `${fx.repo}-${ref}-task`;
    const cleaned = task.events.find(
      (event: { kind: string }) => event.kind === "worktree_cleaned",
    );
    assert.ok(cleaned, "合入后没清理工作树");
    assert.ok(
      JSON.parse(cleaned.detail)
        .path.replace(/\\/g, "/")
        .toLowerCase()
        .endsWith(
          (scenario === "given"
            ? "secretary-tree"
            : `repo-${ref}-task`
          ).toLowerCase(),
        ),
      cleaned.detail,
    );
    assert.equal(existsSync(tree), false);
  });
}
