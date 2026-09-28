import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { exec, type Exec } from "../server/tasks/git.ts";
import {
  diffSummary,
  parseReviewVerdict,
  reviewBrief,
  reviewNeed,
  reviewerRefusal,
} from "../server/tasks/gates/review.ts";
import { startApp } from "./task-fixture.ts";

test("是否审阅：风险 high 或 trust 低于 medium", () => {
  const cases = [
    ["low", "high", false],
    ["medium", "medium", false],
    ["medium", "high", false],
    ["high", "high", true],
    ["low", "low", true],
    ["low", "unknown", true],
    ["low", undefined, true],
    ["high", "low", true],
  ] as const;
  for (const [risk, trust, needed] of cases)
    assert.equal(reviewNeed(risk, trust).needed, needed, `${risk}/${trust}`);
  assert.deepEqual(reviewNeed("high", "low"), {
    needed: true,
    reason: "任务风险 high，执行者 trust=low",
  });
  assert.deepEqual(reviewNeed("low", undefined), {
    needed: true,
    reason: "执行者 trust=unknown",
  });
});

test("审阅者须不同工具、不同模型且 trust 至少 medium", () => {
  const original = { tool: "kimi", model: "k2" };
  assert.match(
    reviewerRefusal(original, { tool: "kimi", trust: "high" })!,
    /同一工具/,
  );
  assert.match(
    reviewerRefusal(original, {
      tool: "opencode",
      model: "k2",
      trust: "high",
    })!,
    /同一模型 k2/,
  );
  assert.match(
    reviewerRefusal(original, { tool: "grok", trust: "low" })!,
    /trust=low/,
  );
  assert.match(reviewerRefusal(original, { tool: "grok" })!, /trust=unknown/);
  assert.equal(
    reviewerRefusal(original, { tool: "grok", model: "g4", trust: "medium" }),
    undefined,
  );
  // 原执行者没写模型时只比工具。
  assert.equal(
    reviewerRefusal({ tool: "kimi" }, { tool: "codex", trust: "high" }),
    undefined,
  );
});

test("读审阅结论：取最后一个，之前的文字作意见", () => {
  assert.equal(parseReviewVerdict(null), null);
  assert.equal(parseReviewVerdict("看起来不错"), null);
  assert.equal(parseReviewVerdict("审阅结论：待定"), null);
  assert.deepEqual(parseReviewVerdict("审阅结论：通过"), {
    passed: true,
    notes: "",
  });
  assert.deepEqual(parseReviewVerdict("1. a.ts:3 没处理空值\n审阅结论: 打回"), {
    passed: false,
    notes: "1. a.ts:3 没处理空值",
  });
  assert.deepEqual(
    parseReviewVerdict(
      "格式：审阅结论：通过 或 打回\n问题 x\n**审阅结论：打回**",
    ),
    { passed: false, notes: "格式：审阅结论：通过 或 打回\n问题 x\n**" },
  );
  const long = parseReviewVerdict(`${"问".repeat(2000)}\n审阅结论：打回`)!;
  assert.equal(long.passed, false);
  assert.ok(long.notes.startsWith("…") && long.notes.length === 1501);
});

test("改动规模摘要", () => {
  assert.deepEqual(diffSummary([]), {
    files: 0,
    added: 0,
    removed: 0,
    top: [],
    text: "改动 0 个文件，+0 −0",
  });
  const stats = Array.from({ length: 12 }, (_, i) => ({
    file: `f${i}.ts`,
    added: i,
    removed: 1,
  }));
  const summary = diffSummary(stats);
  assert.equal(summary.files, 12);
  assert.equal(summary.added, 66);
  assert.equal(summary.removed, 12);
  assert.equal(summary.top.length, 10);
  assert.equal(summary.top[0]!.file, "f11.ts");
  assert.match(summary.text, /^改动 12 个文件，\+66 −12：f11\.ts（\+11 −1）、/);
  assert.match(summary.text, / 等$/);
});

test("审阅说明带清单、只读要求与结论格式", () => {
  const text = reviewBrief({
    ref: "t3",
    title: "加功能",
    prUrl: "https://github.com/acme/demo/pull/1",
    repoFlag: "acme/demo",
    worktree: "/w",
    base: "main",
    risk: "high",
    reason: "任务风险 high",
    diff: diffSummary([{ file: "a.ts", added: 2, removed: 1 }]),
    brief: "原详述",
  });
  for (const part of [
    "-R acme/demo",
    "origin/main",
    "改动 1 个文件，+2 −1",
    "原详述",
    "只读",
    "`审阅结论：通过` 或 `审阅结论：打回`",
  ])
    assert.ok(text.includes(part), part);
});

type Scenario =
  | "trusted"
  | "pass"
  | "high_risk"
  | "reject_then_pass"
  | "reject_always"
  | "no_verdict"
  | "no_reviewer"
  | "stopped";

/** 审阅者（假 grok）按场景给结论；次数记在 fixture 根目录。 */
function reviewerScript(scenario: Scenario, root: string) {
  const count = join(root, "review-count");
  const bump = `n=$(cat "${count}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${count}"`;
  if (scenario === "reject_then_pass")
    return `${bump}\nif [ "$n" = 1 ]; then echo '1. done.txt 需要改'; echo '审阅结论：打回'; else echo '审阅结论：通过'; fi`;
  if (scenario === "reject_always")
    return `${bump}\necho '1. done.txt 还是不对'\necho '审阅结论：打回'`;
  if (scenario === "no_verdict") return `${bump}\necho '我看完了'`;
  if (scenario === "stopped") return `${bump}\nsleep 30`;
  return `${bump}\necho '没有问题'\necho '审阅结论：通过'`;
}

for (const scenario of [
  "trusted",
  "pass",
  "high_risk",
  "reject_then_pass",
  "reject_always",
  "no_verdict",
  "no_reviewer",
  "stopped",
] as const) {
  test(`审阅关卡隔离服务与假 gh/执行者：${scenario}`, async (t) => {
    let merged = false;
    let mergeCalls = 0;
    let headBranch = "";
    const { fx, call } = await startApp(t, (fixture) => {
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: fixture.repo,
          encoding: "utf8",
        }).trim();
      const kimi =
        scenario === "trusted"
          ? "trust: medium\nmax_risk: low"
          : scenario === "high_risk"
            ? "trust: high\nmax_risk: high"
            : "trust: low\nmax_risk: low";
      writeFileSync(
        join(fixture.workers, "harness", "kimi.md"),
        `---\n${kimi}\nchecks: [pr_exists, claims_verified]\n---\n`,
      );
      writeFileSync(
        join(fixture.workers, "harness", "grok.md"),
        `---\ntrust: ${scenario === "no_reviewer" ? "low" : "medium"}\n---\n`,
      );
      fixture.script("grok", reviewerScript(scenario, fixture.root));
      git("config", "user.name", "test");
      git("config", "user.email", "test@example.com");
      writeFileSync(join(fixture.repo, "done.txt"), "base\n");
      writeFileSync(
        join(fixture.repo, "package.json"),
        JSON.stringify({ scripts: { check: "true" } }),
      );
      git("add", ".");
      git("commit", "-qm", "检查夹具");
      git("push", "-q", "origin", "main");
      fixture.script(
        "kimi",
        "set -e\necho change >> done.txt\ngit add done.txt\ngit commit -qm 修复\ngit push -q -u origin HEAD\necho 完成",
      );
      const origin = join(fixture.root, "origin.git");
      const remoteHead = () =>
        execFileSync(
          "git",
          ["--git-dir", origin, "rev-parse", `refs/heads/${headBranch}`],
          { encoding: "utf8" },
        ).trim();
      const fake: Exec = async (command, args, options) => {
        if (
          command === "git" &&
          args.includes("get-url") &&
          args.includes("origin")
        )
          return {
            ok: true,
            stdout: "https://github.com/acme/demo.git\n",
            stderr: "",
          };
        if (command !== "gh") return exec(command, args, options);
        assert.equal(args[args.indexOf("-R") + 1], "acme/demo");
        if (args[0] === "pr" && args[1] === "list") {
          headBranch = args[args.indexOf("--head") + 1]!;
          return {
            ok: true,
            stdout: JSON.stringify([
              {
                number: 1,
                url: "https://github.com/acme/demo/pull/1",
                state: "OPEN",
              },
            ]),
            stderr: "",
          };
        }
        if (args[0] === "pr" && args[1] === "view")
          return {
            ok: true,
            stdout: JSON.stringify({
              state: merged ? "MERGED" : "OPEN",
              headRefOid: remoteHead(),
              headRefName: headBranch,
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
    const created = await call("POST", "/api/tasks", {
      title: "审阅测试",
      repo: fx.repo,
    });
    assert.equal(created.status, 201);
    const ref = created.body.ref as string;
    assert.equal(
      (
        await call("POST", `/api/tasks/${ref}/run`, {
          worker: "kimi",
          ...(scenario === "high_risk" ? { risk: "high" } : {}),
        })
      ).status,
      200,
    );
    if (scenario === "stopped") {
      const until = Date.now() + 10_000;
      for (;;) {
        const current = (await call("GET", `/api/tasks/${ref}`)).body;
        if (current.review_task) {
          const reviewer = (
            await call("GET", `/api/tasks/t${current.review_task}`)
          ).body;
          if (reviewer.status === "running") break;
        }
        assert.ok(Date.now() < until, "等待审阅者启动超时");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal((await call("POST", `/api/tasks/${ref}/stop`)).status, 200);
    }
    const waited = await call("GET", `/api/tasks/${ref}/wait?timeout=40`);
    assert.equal(waited.status, 200);
    assert.equal(waited.body.timed_out, false);
    const task = (await call("GET", `/api/tasks/${ref}`)).body;
    const kinds = task.events.map((event: { kind: string }) => event.kind);
    const count = (kind: string) =>
      kinds.filter((k: string) => k === kind).length;
    const listed = (await call("GET", "/api/tasks")).body;
    const reviewers = (
      (listed.tasks ?? listed) as { title: string; status: string }[]
    ).filter((item) => item.title.startsWith(`审阅 ${ref}`));
    const events = JSON.stringify(task.events);
    if (scenario === "trusted") {
      assert.equal(task.delivery_stage, "merged");
      assert.equal(count("review_needed"), 0);
      assert.equal(reviewers.length, 0);
      assert.equal(mergeCalls, 1);
    } else if (
      scenario === "pass" ||
      scenario === "high_risk" ||
      scenario === "reject_then_pass"
    ) {
      assert.equal(task.delivery_stage, "merged", events);
      assert.equal(task.status, "done");
      assert.equal(mergeCalls, 1);
      const rounds = scenario === "reject_then_pass" ? 2 : 1;
      assert.equal(count("review_needed"), rounds);
      assert.equal(count("review_passed"), 1);
      assert.equal(count("review_rejected"), rounds - 1);
      assert.equal(task.merge_returns, rounds - 1);
      assert.equal(reviewers.length, rounds);
      assert.ok(reviewers.every((item) => item.status === "done"));
      assert.match(
        events,
        scenario === "high_risk" ? /任务风险 high/ : /执行者 trust=low/,
      );
      // 秘书在合入前能看到的改动规模摘要。
      assert.match(events, /改动 1 个文件，\+1 −0：done\.txt/);
      // 审阅任务本身不单独投给秘书，结论在原任务上。
      const inbox = (
        await call("GET", "/api/events/wait?as=secretary&timeout=0&all=1")
      ).body.events as { task: string }[];
      assert.ok(inbox.some((event) => event.task === ref));
      assert.ok(
        inbox.every((event) => event.task === ref),
        JSON.stringify(inbox),
      );
      if (scenario === "reject_then_pass")
        assert.match(
          events,
          /审阅打回（t\d+，grok[^）]*）：1\. done\.txt 需要改/,
        );
    } else if (scenario === "reject_always") {
      assert.equal(task.status, "blocked");
      assert.equal(task.delivery_stage, null);
      assert.equal(task.merge_returns, 3);
      assert.equal(count("review_rejected"), 3);
      assert.equal(count("merge_returned"), 2);
      assert.equal(count("merge_blocked"), 1);
      assert.equal(reviewers.length, 3);
      assert.equal(mergeCalls, 0);
    } else {
      assert.equal(task.status, "blocked");
      assert.equal(task.delivery_stage, null);
      assert.equal(task.merge_returns, 0);
      assert.equal(mergeCalls, 0);
      assert.equal(count("review_blocked"), 1);
      assert.match(
        events,
        scenario === "no_verdict"
          ? /没有写「审阅结论：通过\/打回」/
          : scenario === "no_reviewer"
            ? /找不到合格的审阅者.*grok 的档案 trust=low/
            : /用户停止审阅/,
      );
      assert.equal(reviewers.length, scenario === "no_reviewer" ? 0 : 1);
      if (scenario === "stopped") {
        // 审阅者被停掉后收尾，不会把原任务拉回审阅或合入。
        const reviewer = `t${task.review_task}`;
        const ended = await call(
          "GET",
          `/api/tasks/${reviewer}/wait?timeout=20`,
        );
        assert.equal(ended.body.timed_out, false);
        assert.notEqual(ended.body.task.status, "running");
        await new Promise((resolve) => setTimeout(resolve, 300));
        const after = (await call("GET", `/api/tasks/${ref}`)).body;
        assert.equal(after.status, "blocked");
        assert.equal(after.delivery_stage, null);
        assert.equal(mergeCalls, 0);
      }
    }
  });
}

test("审阅关卡从账本续上：结论、失败、仍在排队、派不出去", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { ensureTaskTables } =
    await import("../server/tasks/ledger/ledger-schema.ts");
  const { ReviewGate } =
    await import("../server/tasks/gates/review-runtime.ts");
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const insert = db.prepare(
    "INSERT INTO tasks(title,deliver,status,worker,result,delivery_stage,review_task,repo,worktree,pr_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,1)",
  );
  const original = (review: number) =>
    Number(
      insert.run(
        "原任务",
        "pr",
        "done",
        "kimi",
        null,
        "reviewing",
        review,
        "/r",
        "/w",
        "https://github.com/acme/demo/pull/1",
      ).lastInsertRowid,
    );
  const reviewer = (status: string, result: string | null) =>
    Number(
      insert.run(
        "审阅",
        "none",
        status,
        "grok",
        result,
        null,
        null,
        null,
        null,
        null,
      ).lastInsertRowid,
    );
  const passed = original(reviewer("done", "审阅结论：通过"));
  const failed = original(reviewer("failed", null));
  const waiting = original(reviewer("todo", null));
  const stuck = original(reviewer("todo", null));
  const rejected = original(reviewer("done", "a.ts 有问题\n审阅结论：打回"));
  // 服务重启后接管的纯文本审阅者：退出码不可得判 failed，但写了结论照样采信。
  const adoptedReviewer = reviewer("failed", "看完了\n审阅结论：通过");
  const adoptedEvent = db.prepare(
    "INSERT INTO task_events(task_id,at,kind,detail) VALUES (?,1,'exit_fail',?)",
  );
  adoptedEvent.run(
    adoptedReviewer,
    JSON.stringify({ detail: { reason: "接管后退出，退出码不可得" } }),
  );
  const adopted = original(adoptedReviewer);
  // 别的原因失败的，即使输出里有结论也不采信。
  const killedReviewer = reviewer("failed", "审阅结论：通过");
  adoptedEvent.run(
    killedReviewer,
    JSON.stringify({ detail: { reason: "人工停止" } }),
  );
  const killed = original(killedReviewer);
  const enqueued: number[] = [];
  const handed: [number, string][] = [];
  const published: [number, string, Record<string, unknown>][] = [];
  const gate = new ReviewGate(db, {
    data: "/unused",
    run: async () => ({ ok: false, stdout: "", stderr: "unused" }),
    pickReviewer: async () => "grok",
    launch: async (ref) => {
      if (ref === `t${stuck - 1}`) throw new Error("额度不足");
    },
    inFlight: (id) => id === waiting - 1,
    stopTask: () => {},
    enqueue: (id) => enqueued.push(id),
    handBack: async (task, reason) => {
      handed.push([task.id, reason]);
    },
    publish: (id, kind, detail) => published.push([id, kind, detail]),
    changed: () => {},
  });
  gate.kick();
  const until = Date.now() + 2000;
  while (handed.length === 0 || enqueued.length < 2) {
    assert.ok(Date.now() < until, "巡检没有跑完");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stage = (id: number) => ({
    ...(db
      .prepare("SELECT status,delivery_stage FROM tasks WHERE id=?")
      .get(id) as { status: string; delivery_stage: string | null }),
  });
  assert.deepEqual(enqueued, [passed, adopted]);
  assert.deepEqual(stage(killed), { status: "blocked", delivery_stage: null });
  assert.equal(handed.length, 1);
  assert.equal(handed[0]![0], rejected);
  assert.match(handed[0]![1], /审阅打回（t\d+，grok）：a\.ts 有问题/);
  assert.deepEqual(stage(failed), { status: "blocked", delivery_stage: null });
  assert.deepEqual(stage(waiting), {
    status: "done",
    delivery_stage: "reviewing",
  });
  assert.deepEqual(stage(stuck), { status: "blocked", delivery_stage: null });
  const reasons = published
    .filter(([, kind]) => kind === "blocked")
    .map(([id, , detail]) => [id, detail.reason]);
  assert.deepEqual(reasons, [
    [failed, `审阅任务 t${failed - 1} failed，没有给出结论`],
    [stuck, `审阅任务 t${stuck - 1} 派不出去：额度不足`],
    [killed, `审阅任务 t${killedReviewer} failed，没有给出结论`],
  ]);
  gate.close();
  db.close();
});
