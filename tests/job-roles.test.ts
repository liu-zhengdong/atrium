import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  ensureTaskTables,
  createTask,
  advanceTask,
  noteTask,
} from "../server/tasks/ledger.ts";
import {
  createJobRole,
  editJobRole,
  getJobRole,
  jobRoleHistory,
} from "../server/tasks/job-roles.ts";
import {
  listDeliveries,
  summarizeDeliveries,
  adviceFor,
  activeJobChecks,
} from "../server/tasks/delivery-records.ts";
import { rankRoleWorkers } from "../server/tasks/role-ranking.ts";
import { jobMismatch } from "../server/tasks/job-mismatch.ts";
const db = () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  return db;
};
const role = (db: DatabaseSync) =>
  createJobRole(db, {
    name: "后端",
    description: "实现服务功能",
    body: "本地检查通过",
    preferred: ["codex+gpt-6-sol:high"],
    checks: ["local_check"],
    skills: [],
  });

test("角色短号、修订历史与任务 --job 分开于旧 --role；破坏输入拒绝", () => {
  const d = db();
  const r = role(d);
  assert.equal(r.ref, "r1");
  assert.equal(
    createTask(d, { title: "服务", job: "后端", role: "旧岗位" }).job_ref,
    "r1",
  );
  assert.equal(editJobRole(d, "后端", { description: "维护服务" }).rev, 2);
  assert.deepEqual(
    jobRoleHistory(d, "r1").map((x) => x.rev),
    [2, 1],
  );
  assert.throws(() => role(d), /已存在/);
  assert.throws(
    () => createTask(d, { title: "坏任务", job: "不存在" }),
    /不存在/,
  );
  assert.throws(
    () =>
      createJobRole(d, {
        name: "前端",
        description: "界面",
        body: "要求",
        preferred: ["codex+gpt-6-sol:invalid"],
        checks: [],
      }),
    /思考强度|不支持/,
  );
  d.close();
});

test("交付事实、冲突不归责、未知强度、五次样本后建议", () => {
  const d = db();
  const r = role(d);
  for (let i = 0; i < 5; i++) {
    const task = createTask(d, { title: `交付${i}`, job: r.ref });
    advanceTask(
      d,
      task.ref,
      { kind: "start" },
      { worker: "codex+gpt-6-sol:high" },
      { worker: "codex+gpt-6-sol:high", risk: "low" },
      1000 + i * 100,
    );
    noteTask(
      d,
      task.id,
      "gates",
      { passed: true, results: [], diff: { files: 2, added: 10, deleted: 1 } },
      1100 + i * 100,
    );
    advanceTask(
      d,
      task.ref,
      { kind: "exit_ok" },
      {},
      undefined,
      1200 + i * 100,
    );
    if (i === 0)
      noteTask(
        d,
        task.id,
        "merge_returned",
        { reason: "rebase 冲突" },
        1300 + i * 100,
      );
  }
  const rows = listDeliveries(d);
  assert.equal(rows.length, 5);
  assert.equal(rows[0]!.effort, "high");
  const conflict = rows.find((x) => x.rebase_conflicts === 1)!;
  assert.equal(conflict.merge_returns.length, 0);
  assert.equal(conflict.first_pass, true);
  const stat = summarizeDeliveries(rows).find(
    (s) => s.scope === "combination",
  )!;
  assert.equal(stat.deliveries, 5);
  assert.equal(stat.first_pass_rate, 1);
  assert.equal(stat.low_data, false);
  assert.equal(adviceFor(stat)?.action, "relax");
  d.prepare("DELETE FROM deliveries WHERE id=?").run(rows[0]!.id);
  assert.equal(
    summarizeDeliveries(listDeliveries(d)).find(
      (s) => s.scope === "combination",
    )!.low_data,
    true,
  );
  assert.deepEqual(
    rankRoleWorkers(["claude+opus:high", "codex+gpt-6-sol:high"], [], "后端"),
    ["claude+opus:high", "codex+gpt-6-sol:high"],
  );
  d.close();
});

test("旧任务回填缺失强度不猜；角色不符只提醒", () => {
  const d = db();
  const t = createTask(d, { title: "旧活" });
  d.prepare(
    "UPDATE tasks SET worker='claude+opus',status='done',started_at=10,ended_at=20 WHERE id=?",
  ).run(t.id);
  d.prepare(
    "INSERT INTO task_events(task_id,at,kind,detail) VALUES (?,?,?,?)",
  ).run(
    t.id,
    10,
    "start",
    JSON.stringify({ detail: { worker: "claude+opus" } }),
  );
  d.prepare(
    "INSERT INTO task_events(task_id,at,kind,detail) VALUES (?,?,?,?)",
  ).run(t.id, 20, "exit_ok", "{}");
  ensureTaskTables(d);
  const [row] = listDeliveries(d);
  assert.equal(row?.historical, 1);
  assert.equal(row?.effort, null);
  assert.match(
    jobMismatch("后端", [
      "server/map/web/app.js",
      "server/map/web/style.css",
      "server/app.ts",
    ])!,
    /后端/,
  );
  assert.equal(
    jobMismatch("后端", ["server/tasks/a.ts", "server/tasks/b.ts"]),
    null,
  );
  d.close();
});

test("截图关卡只认 PR 正文里的实际图片附件", async () => {
  const { evaluateGates } = await import("../server/tasks/gates.ts");
  const base = {
    repo: true,
    branch: "x",
    base: "main",
    pr: {
      number: 1,
      url: "https://github.com/a/b/pull/1",
      state: "OPEN",
      body: "已截图",
    },
    ci: null,
    numstat: [],
    functions: [],
    dirty: [],
    ahead: 1,
    pushed: true,
    claims: [],
  };
  assert.equal(evaluateGates(["screenshot"], {}, base).passed, false);
  assert.equal(
    evaluateGates(
      ["screenshot"],
      {},
      {
        ...base,
        pr: { ...base.pr, body: "![页面](https://example.com/screen.png)" },
      },
    ).passed,
    true,
  );
});

test("确认建议后写入隔离档案，当前样本的建议消失", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { workersReport, confirmWorkerAdvice } =
    await import("../server/tasks/workers-report.ts");
  const dir = mkdtempSync(join(tmpdir(), "atrium-job-workers-"));
  const d = db();
  const r = role(d);
  try {
    for (let i = 0; i < 5; i++) {
      const t = createTask(d, { title: `事实${i}`, job: r.ref });
      advanceTask(
        d,
        t.ref,
        { kind: "start" },
        { worker: "codex+gpt-6-sol:high" },
        { worker: "codex+gpt-6-sol:high", risk: "low" },
        100 + i * 100,
      );
      noteTask(d, t.id, "gates", { passed: true, results: [] }, 110 + i * 100);
      advanceTask(d, t.ref, { kind: "exit_ok" }, {}, undefined, 120 + i * 100);
    }
    assert.equal((await workersReport(d, r.ref, dir)).suggestions.length, 1);
    await confirmWorkerAdvice(
      d,
      { worker: "codex+gpt-6-sol:high", role: r.ref, action: "relax" },
      dir,
    );
    assert.match(
      readFileSync(join(dir, "combos", "codex+gpt-6-sol.md"), "utf8"),
      /trust: low/,
    );
    assert.equal((await workersReport(d, r.ref, dir)).suggestions.length, 0);
  } finally {
    d.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("执行中角色关卡用派活时修订；统计跨有界分页包含所有交付", () => {
  const d = db();
  const r = role(d);
  const t = createTask(d, { title: "修订中", job: r.ref });
  advanceTask(
    d,
    t.ref,
    { kind: "start" },
    { worker: "codex+gpt-6-sol:high" },
    { worker: "codex+gpt-6-sol:high", risk: "low" },
    100,
  );
  editJobRole(d, r.ref, { checks: ["screenshot"] });
  assert.deepEqual(activeJobChecks(d, t.id), ["local_check"]);
  advanceTask(d, t.ref, { kind: "exit_ok" }, {}, undefined, 110);
  for (let i = 0; i < 205; i++) {
    const row = createTask(d, { title: `历史${i}`, job: r.ref });
    d.prepare(
      "UPDATE tasks SET worker='codex+gpt-6-sol',status='done' WHERE id=?",
    ).run(row.id);
    d.prepare(
      "INSERT INTO task_events(task_id,at,kind,detail) VALUES(?,?,?,?)",
    ).run(
      row.id,
      200 + i * 10,
      "start",
      JSON.stringify({ detail: { worker: "codex+gpt-6-sol" } }),
    );
    d.prepare(
      "INSERT INTO task_events(task_id,at,kind,detail) VALUES(?,?,?,?)",
    ).run(row.id, 205 + i * 10, "exit_ok", "{}");
  }
  ensureTaskTables(d);
  assert.equal(listDeliveries(d).length, 206);
  d.close();
});

test("组合样本少时按模型行排序，角色避让仍作用于默认挑人", async () => {
  const { pickWorker } = await import("../server/tasks/prepare.ts");
  const stats = [
    {
      scope: "model" as const,
      worker: "codex+gpt-6-sol",
      role: "后端",
      deliveries: 8,
      first_pass_rate: 1,
      average_returns: 0,
      median_ms: 100,
      incidents: 0,
      low_data: false,
      trust: "medium",
    },
  ];
  assert.deepEqual(
    rankRoleWorkers(
      ["claude+opus:high", "codex+gpt-6-sol:high"],
      stats,
      "后端",
    ),
    ["codex+gpt-6-sol:high", "claude+opus:high"],
  );
  const choice = pickWorker({
    installed: { codex: "/tmp/codex", claude: "/tmp/claude" },
    risk: "low",
    profiles: {
      codex: {
        rules: { avoid_jobs: ["r1"] },
        body: "",
        layers: [],
        warnings: [],
      },
      claude: { rules: {}, body: "", layers: [], warnings: [] },
    },
    jobRef: "r1",
  });
  assert.equal(choice.ok && choice.tool, "claude");
});
