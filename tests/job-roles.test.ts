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
  activeJobChecks,
  markDeliveryFinal,
} from "../server/tasks/delivery-records.ts";
import { removeTemp } from "./temp-dir.ts";
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

test("专员短号、修订历史与任务 --by；破坏输入拒绝", () => {
  const d = db();
  const r = role(d);
  assert.equal(r.ref, "r1");
  assert.equal(createTask(d, { title: "服务", by: "后端" }).job_ref, "r1");
  assert.equal(editJobRole(d, "后端", { description: "维护服务" }).rev, 2);
  assert.deepEqual(
    jobRoleHistory(d, "r1").map((x) => x.rev),
    [2, 1],
  );
  assert.throws(() => role(d), /已存在/);
  assert.throws(
    () => createTask(d, { title: "旧写法", job: "后端" }),
    /不认识的字段：job/,
  );
  assert.throws(
    () => createTask(d, { title: "坏任务", by: "不存在" }),
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

test("交付事实、冲突不归责、未知强度、五次样本后数据够", () => {
  const d = db();
  const r = role(d);
  for (let i = 0; i < 5; i++) {
    const task = createTask(d, { title: `交付${i}`, by: r.ref });
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
  markDeliveryFinal(d, conflict.task_id, "rebase_conflict");
  assert.equal(
    listDeliveries(d).find((x) => x.task_id === conflict.task_id)
      ?.final_outcome,
    "rebase_conflict",
  );
  const stat = summarizeDeliveries(rows).find(
    (s) => s.scope === "combination",
  )!;
  assert.equal(stat.deliveries, 5);
  assert.equal(stat.first_pass_rate, 1);
  assert.equal(stat.low_data, false);
  d.prepare("DELETE FROM task_deliveries WHERE id=?").run(rows[0]!.id);
  assert.equal(
    summarizeDeliveries(listDeliveries(d)).find(
      (s) => s.scope === "combination",
    )!.low_data,
    true,
  );
  d.close();
});

test("旧任务回填缺失强度不猜", () => {
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
  d.close();
});

test("角色可配置 screenshots，未知关卡仍拒绝", async () => {
  const { evaluateGates } = await import("../server/tasks/gates.ts");
  const d = db();
  const r = role(d);
  assert.deepEqual(
    editJobRole(d, r.ref, { checks: ["local_check", "screenshots"] }).checks,
    ["local_check", "screenshots"],
  );
  assert.throws(
    () => editJobRole(d, r.ref, { checks: ["not_a_gate"] }),
    /checks: 未知验收关卡 not_a_gate/,
  );
  d.close();
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
  assert.equal(evaluateGates(["screenshots"], {}, base).passed, false);
  assert.equal(
    evaluateGates(
      ["screenshots"],
      {},
      {
        ...base,
        pr: { ...base.pr, body: "![页面](https://example.com/screen.png)" },
        screenshots: [{ url: "https://example.com/screen.png", status: 200 }],
      },
    ).passed,
    true,
  );
});

test("执行中角色关卡用派活时修订；统计跨有界分页包含所有交付", () => {
  const d = db();
  const r = role(d);
  const t = createTask(d, { title: "修订中", by: r.ref });
  advanceTask(
    d,
    t.ref,
    { kind: "start" },
    { worker: "codex+gpt-6-sol:high" },
    { worker: "codex+gpt-6-sol:high", risk: "low" },
    100,
  );
  editJobRole(d, r.ref, { checks: ["screenshots"] });
  assert.deepEqual(activeJobChecks(d, t.id), ["local_check"]);
  advanceTask(d, t.ref, { kind: "exit_ok" }, {}, undefined, 110);
  for (let i = 0; i < 205; i++) {
    const row = createTask(d, { title: `历史${i}`, by: r.ref });
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
  const next = createTask(d, { title: "下一轮", by: r.ref });
  advanceTask(
    d,
    next.ref,
    { kind: "start" },
    { worker: "codex+gpt-6-sol:high" },
    { worker: "codex+gpt-6-sol:high", risk: "low" },
    3000,
  );
  assert.deepEqual(activeJobChecks(d, next.id), ["screenshots"]);
  d.close();
});

test("专员避让作用于默认挑人", async () => {
  const { pickWorker } = await import("../server/tasks/prepare.ts");
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
