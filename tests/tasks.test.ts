import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TASK_EVENT_KINDS,
  TASK_STATUSES,
  transition,
  type TaskEvent,
  type TaskStatus,
} from "../server/tasks/state.ts";
import {
  advanceTask,
  clipResult,
  createTask,
  ensureTaskTables,
  getTask,
  listTasks,
  parseTaskRef,
  RESULT_MAX_BYTES,
  taskTree,
  updateTask,
} from "../server/tasks/ledger.ts";
import { createApp } from "../server/app.ts";
import { renderTree } from "../cli/tasks.ts";
import { cliErrorMessage } from "../cli/error-message.ts";
import { commands } from "../cli/main.ts";

const S = TASK_STATUSES;
/** 期望表：事件 → 当前状态 → 新状态（null 表示拒绝）。 */
const expected: Record<
  Exclude<TaskEvent["kind"], "manual_set">,
  Record<TaskStatus, TaskStatus | null>
> = {
  start: {
    todo: "running",
    running: null,
    done: null,
    failed: "running",
    blocked: "running",
    cancelled: null,
  },
  exit_ok: {
    todo: null,
    running: "done",
    done: null,
    failed: null,
    blocked: null,
    cancelled: null,
  },
  exit_fail: {
    todo: null,
    running: "failed",
    done: null,
    failed: null,
    blocked: null,
    cancelled: null,
  },
  block: {
    todo: "blocked",
    running: "blocked",
    done: null,
    failed: null,
    blocked: null,
    cancelled: null,
  },
  cancel: {
    todo: "cancelled",
    running: "cancelled",
    done: null,
    failed: "cancelled",
    blocked: "cancelled",
    cancelled: null,
  },
};

test("状态转移穷举：6 个状态 × 全部事件（manual_set 再乘 6 个目标）", () => {
  assert.deepEqual(
    [...TASK_EVENT_KINDS].sort(),
    [...Object.keys(expected), "manual_set"].sort(),
  );
  let cases = 0;
  for (const from of S) {
    for (const [kind, table] of Object.entries(expected)) {
      const result = transition(from, { kind } as TaskEvent);
      const want = table[from];
      cases++;
      if (want === null) {
        assert.equal(result.ok, false, `${from} + ${kind} 应拒绝`);
        if (!result.ok) assert.match(result.reason, /[一-鿿]/);
      } else
        assert.deepEqual(
          result,
          { ok: true, status: want, changed: want !== from },
          `${from} + ${kind}`,
        );
    }
    for (const target of S) {
      cases++;
      const result = transition(from, { kind: "manual_set", to: target });
      if (target === "running" && from !== "running")
        assert.equal(result.ok, false, `${from} 不能人工置 running`);
      else
        assert.deepEqual(result, {
          ok: true,
          status: target,
          changed: target !== from,
        });
    }
    const bogus = transition(from, {
      kind: "manual_set",
      to: "archived" as TaskStatus,
    });
    assert.equal(bogus.ok, false);
  }
  assert.equal(cases, 6 * 5 + 6 * 6);
});

function memory() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureTaskTables(db);
  ensureTaskTables(db); // 幂等
  return db;
}

test("账本：建树、列表、详情、人工修正与执行者事件", () => {
  const db = memory();
  const root = createTask(db, { title: "  上线  任务账本 " }, 1000);
  assert.equal(root.ref, "t1");
  assert.equal(root.title, "上线 任务账本");
  assert.equal(root.status, "todo");
  const child = createTask(
    db,
    {
      title: "表与状态机",
      parent: "t1",
      role: "concerns/安全",
      repo: "/tmp/r",
    },
    1001,
  );
  const grandchild = createTask(db, { title: "测试", parent: 2 }, 1002);
  createTask(db, { title: "另一目标" }, 1003);
  assert.equal(child.parent_ref, "t1");
  assert.equal(grandchild.parent_ref, "t2");

  const tree = taskTree(db);
  assert.deepEqual(
    tree.tasks.map((node) => node.ref),
    ["t1", "t4"],
  );
  assert.equal(tree.tasks[0]!.children[0]!.children[0]!.ref, "t3");
  const sub = taskTree(db, "t2");
  assert.equal(sub.tasks.length, 1);
  assert.equal(sub.tasks[0]!.children[0]!.ref, "t3");

  assert.deepEqual(
    listTasks(db, { parent: "t1" }).tasks.map((task) => task.ref),
    ["t2"],
  );
  const page = listTasks(db, { limit: "2" });
  assert.equal(page.next_after, "t2");
  assert.deepEqual(
    listTasks(db, { after: page.next_after, limit: "2" }).tasks.map(
      (task) => task.ref,
    ),
    ["t3", "t4"],
  );

  const running = advanceTask(
    db,
    "t2",
    { kind: "start" },
    {
      worker: "codex",
      pid: 42,
    },
    undefined,
    2000,
  );
  assert.equal(running.status, "running");
  assert.equal(running.started_at, 2000);
  assert.equal(listTasks(db, { status: "running" }).tasks.length, 1);
  assert.throws(
    () => advanceTask(db, "t2", { kind: "start" }),
    (error: { statusCode: number; message: string }) =>
      error.statusCode === 409 && /重复启动/.test(error.message),
  );
  const done = advanceTask(
    db,
    "t2",
    { kind: "exit_ok" },
    {
      pr_url: "https://github.com/o/r/pull/1",
      result: "é".repeat(RESULT_MAX_BYTES),
    },
    undefined,
    3000,
  );
  assert.equal(done.status, "done");
  assert.equal(done.ended_at, 3000);
  assert(Buffer.byteLength(done.result!, "utf8") <= RESULT_MAX_BYTES);
  assert.equal(clipResult("短"), "短");

  const reopened = updateTask(
    db,
    "t2",
    { status: "todo", title: "表与状态机 v2" },
    4000,
  );
  assert.equal(reopened.status, "todo");
  assert.equal(reopened.ended_at, null);
  assert.equal(reopened.title, "表与状态机 v2");
  const detail = getTask(db, "t2");
  assert.equal(detail.children, 1);
  assert.deepEqual(
    detail.events.map((event) => event.kind),
    ["created", "start", "exit_ok", "edited", "manual_set"],
  );
  // 同状态修正不记事件。
  updateTask(db, "t2", { status: "todo" });
  assert.equal(getTask(db, "t2").events.length, 5);
});

test("账本：破坏输入在入口一处拒绝，数据不变", () => {
  const db = memory();
  createTask(db, { title: "目标" });
  const rejects = (fn: () => unknown, status: number, pattern: RegExp) =>
    assert.throws(fn, (error: { statusCode: number; message: string }) => {
      assert.equal(error.statusCode, status);
      assert.match(error.message, pattern);
      return true;
    });
  rejects(() => createTask(db, { title: "" }), 400, /标题不能为空/);
  rejects(() => createTask(db, { title: "   " }), 400, /标题不能为空/);
  rejects(() => createTask(db, {}), 400, /标题不能为空/);
  rejects(
    () => createTask(db, { title: "x", parent: "t9" }),
    400,
    /父任务 t9 不存在/,
  );
  rejects(
    () => createTask(db, { title: "x", parent: "x9" }),
    400,
    /t1 这样的格式/,
  );
  rejects(
    () => createTask(db, { title: "x", repo: "rel/path" }),
    400,
    /绝对路径/,
  );
  rejects(
    () => createTask(db, { title: "x", owner: "a1" }),
    400,
    /不认识的字段/,
  );
  rejects(() => createTask(db, null), 400, /JSON 对象/);
  rejects(
    () => updateTask(db, "t1", { status: "archived" }),
    400,
    /status: 只能是/,
  );
  rejects(
    () => updateTask(db, "t1", { status: "running" }),
    409,
    /atrium task run/,
  );
  rejects(() => updateTask(db, "t1", {}), 400, /至少修改一项/);
  rejects(() => updateTask(db, "t1", { title: "" }), 400, /标题不能为空/);
  rejects(() => updateTask(db, "t1", { worker: "codex" }), 400, /不认识的字段/);
  rejects(() => getTask(db, "t2"), 404, /t2 不存在/);
  rejects(() => taskTree(db, "t2"), 404, /t2 不存在/);
  rejects(() => listTasks(db, { status: "doing" }), 400, /只能是/);
  rejects(() => listTasks(db, { parent: "t5" }), 400, /父任务 t5 不存在/);
  rejects(() => listTasks(db, { limit: "9999" }), 400, /limit/);
  rejects(() => parseTaskRef("t0"), 400, /格式/);
  rejects(() => parseTaskRef("t1.5"), 400, /格式/);
  assert.equal(parseTaskRef("t12"), 12);
  assert.equal(listTasks(db, {}).tasks.length, 1);
  assert.equal(getTask(db, "t1").events.length, 1);
  // 表上的 CHECK 兜住绕过领域函数的写入。
  assert.throws(() =>
    db.prepare("UPDATE tasks SET status='archived' WHERE id=1").run(),
  );
});

test("HTTP：五个接口走用户认证，校验报中文 400", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-tasks-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const guarded = await createApp({
    data: join(data, "guarded"),
    runtime: false,
  });
  try {
    for (const [method, url] of [
      ["POST", "/api/tasks"],
      ["GET", "/api/tasks"],
      ["GET", "/api/tasks/tree"],
      ["GET", "/api/tasks/t1"],
      ["PATCH", "/api/tasks/t1"],
    ] as const) {
      const response = await guarded.app.inject({
        method,
        url,
        headers: { host: "127.0.0.1" },
        ...(method === "GET" ? {} : { payload: { title: "x" } }),
      });
      assert.equal(response.statusCode, 401, `${method} ${url}`);
    }
  } finally {
    await guarded.app.close();
  }

  const { app } = await createApp({ data, runtime: false, auth: false });
  const headers = { host: "127.0.0.1" };
  try {
    const post = (payload: unknown) =>
      app.inject({
        method: "POST",
        url: "/api/tasks",
        headers,
        payload: payload as object,
      });
    const created = await post({ title: "目标" });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().ref, "t1");
    assert.equal((await post({ title: "子", parent: "t1" })).json().ref, "t2");
    for (const [payload, pattern] of [
      [{ title: "" }, /title: 标题不能为空/],
      [{ title: "x", parent: "t42" }, /parent: 父任务 t42 不存在/],
    ] as const) {
      const response = await post(payload);
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "usage");
      assert.match(response.json().error, pattern);
    }
    const bad = await app.inject({
      method: "PATCH",
      url: "/api/tasks/t1",
      headers,
      payload: { status: "archived" },
    });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /status: 只能是 todo、running/);
    assert.equal(
      cliErrorMessage(bad.json().error, commands["task set"]),
      "--status：只能是 todo、running、done、failed、blocked、cancelled",
    );
    assert.equal(
      cliErrorMessage("title: 标题不能为空", commands["task add"]),
      "标题：标题不能为空",
    );
    const listed = await app.inject({
      url: "/api/tasks?parent=t1&status=todo",
      headers,
    });
    assert.deepEqual(
      listed.json().tasks.map((task: { ref: string }) => task.ref),
      ["t2"],
    );
    const tree = await app.inject({ url: "/api/tasks/tree?root=t1", headers });
    assert.equal(tree.json().tasks[0].children[0].ref, "t2");
    const patched = await app.inject({
      method: "PATCH",
      url: "/api/tasks/2",
      headers,
      payload: { status: "done" },
    });
    assert.equal(patched.json().status, "done");
    const shown = await app.inject({ url: "/api/tasks/t2", headers });
    assert.equal(shown.json().events.at(-1).kind, "manual_set");
    const missing = await app.inject({ url: "/api/tasks/t99", headers });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().nextCommand, "atrium task ls");
    const malformed = await app.inject({ url: "/api/tasks/abc", headers });
    assert.equal(malformed.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("命令行缩进树：短号、状态、标题、执行者、PR", () => {
  const node = (
    ref: string,
    status: TaskStatus,
    title: string,
    extra: Record<string, unknown> = {},
    children: unknown[] = [],
  ) => ({ ref, status, title, worker: null, pr_url: null, ...extra, children });
  const lines = renderTree([
    node("t1", "running", "目标", {}, [
      node(
        "t2",
        "done",
        "子一",
        {
          worker: "codex",
          pr_url: "https://github.com/o/r/pull/7",
        },
        [node("t4", "todo", "孙")],
      ),
      node("t3", "failed", "子二"),
    ]),
  ] as never);
  assert.deepEqual(lines, [
    "t1 [running] 目标",
    "  t2 [done] 子一 · codex · https://github.com/o/r/pull/7",
    "    t4 [todo] 孙",
    "  t3 [failed] 子二",
  ]);
});
