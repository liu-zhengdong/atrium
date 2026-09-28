import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TASK_EVENT_KINDS,
  TASK_STATUSES,
  transition,
  type TaskEvent,
  type TaskStatus,
} from "../server/tasks/ledger/state.ts";
import {
  advanceTask,
  addTaskNote,
  clipResult,
  createTask,
  ensureTaskTables,
  getTask,
  listTasks,
  parseTaskRef,
  RESULT_MAX_BYTES,
  taskTree,
  updateTask,
} from "../server/tasks/ledger/ledger.ts";
import { createApp } from "../server/app.ts";
import { renderTree } from "../cli/tasks.ts";
import { isProcessing } from "../server/tasks/ledger/notes.ts";
import { cliErrorMessage } from "../cli/error-message.ts";
import { commands } from "../cli/main.ts";
import { removeTemp } from "./temp-dir.ts";

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
  accept: {
    todo: null,
    running: "done",
    done: null,
    failed: null,
    blocked: "done",
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
  assert.equal(cases, 6 * 6 + 6 * 6);
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
  assert.equal(root.deliver, "pr");
  assert.equal(root.issue, null);
  const child = createTask(
    db,
    {
      title: "表与状态机",
      parent: "t1",
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
  assert.throws(
    () => updateTask(db, "t2", { deliver: "none" }),
    /执行中不能修改交付物类型/,
  );
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

test("总任务：子任务汇总只计直接子任务，状态与进度按全部叶子汇总（t190）", () => {
  const db = memory();
  const parent = createTask(db, { title: "目标" });
  const statuses = TASK_STATUSES;
  for (const childStatus of statuses) {
    const child = createTask(db, { title: childStatus, parent: parent.ref });
    if (childStatus === "running")
      advanceTask(db, child.ref, { kind: "start" });
    else if (childStatus !== "todo")
      updateTask(db, child.ref, { status: childStatus });
  }
  createTask(db, { title: "孙任务", parent: "t2" });
  const summary = {
    total: 6,
    todo: 1,
    running: 1,
    done: 1,
    failed: 1,
    blocked: 1,
    cancelled: 1,
  };
  assert.deepEqual(getTask(db, parent.ref).child_summary, summary);
  assert.deepEqual(taskTree(db, parent.ref).tasks[0]!.child_summary, summary);
  assert.equal(getTask(db, "t2").child_summary?.total, 1);
  assert.equal(getTask(db, "t3").child_summary, null);
  // 叶子：t3 在跑、t4 完成、t5 失败、t6 受阻、t7 取消、t8（t2 的子任务）待办；t2 有子任务，不算叶子。
  const rollup = getTask(db, parent.ref).rollup!;
  assert.equal(rollup.status, "running");
  assert.equal(rollup.leaves, 6);
  assert.equal(rollup.finished, 1);
  assert.deepEqual(rollup.stuck_refs, ["t5", "t6"]);
  assert.equal(getTask(db, "t2").rollup?.status, "todo");
  assert.equal(getTask(db, "t3").rollup, null);
  // 总任务在账本里从不写成 running：有在做的叶子也存 todo。
  assert.equal(getTask(db, parent.ref).status, "todo");
  assert.equal(getTask(db, parent.ref).holder, null);
  assert.equal(
    renderTree(taskTree(db, parent.ref).tasks)[0],
    "t1 [在做 1/5] 目标 · 总任务 · 在做 1（t3） · 卡住 2（t5、t6）",
  );
  assert.equal(
    listTasks(db, {}).tasks.find((task) => task.ref === "t2")!.rollup?.status,
    "todo",
  );
});

test("树被截断时，父任务汇总仍包含未显示的子任务", () => {
  const db = memory();
  const parent = createTask(db, { title: "目标" });
  db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare(
      "INSERT INTO tasks(parent_id,title,status,created_at,updated_at) VALUES (?,?,?,0,0)",
    );
    for (let i = 0; i < 2001; i++) insert.run(parent.id, `子${i}`, "todo");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const tree = taskTree(db, parent.ref);
  assert.equal(tree.truncated, true);
  assert.equal(tree.tasks[0]!.children.length, 1999);
  assert.equal(tree.tasks[0]!.child_summary?.todo, 2001);
  assert.equal(getTask(db, parent.ref).child_summary?.total, 2001);
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
    () => createTask(db, { title: "x", assignee: "a1" }),
    400,
    /不认识的字段/,
  );
  rejects(
    () => createTask(db, { title: "x", owner: "有 空格" }),
    400,
    /owner: 订阅者名/,
  );
  rejects(() => createTask(db, null), 400, /JSON 对象/);
  rejects(
    () => createTask(db, { title: "设计", deliver: "comment" }),
    400,
    /--issue/,
  );
  rejects(
    () => createTask(db, { title: "设计", deliver: "other" }),
    400,
    /deliver/,
  );
  rejects(
    () => createTask(db, { title: "设计", deliver: "comment", issue: "0" }),
    400,
    /issue/,
  );
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
  const design = createTask(db, {
    title: "设计",
    deliver: "comment",
    issue: 262,
  });
  assert.equal(design.deliver, "comment");
  assert.equal(design.issue, 262);
  assert.match(renderTree(taskTree(db, design.ref).tasks)[0]!, /comment #262/);
  assert.match(JSON.stringify(getTask(db, design.ref)), /"deliver":"comment"/);
  rejects(() => updateTask(db, design.ref, { issue: null }), 400, /--issue/);
  assert.equal(
    updateTask(db, design.ref, { deliver: "none", issue: null }).deliver,
    "none",
  );
});

test("处理中判定：所有任务状态与备注、受阻事件的先后边界", () => {
  for (const status of TASK_STATUSES)
    for (const noteId of [null, 9, 10, 11])
      for (const blockedId of [null, 10])
        assert.equal(
          isProcessing(status, noteId, blockedId),
          status === "blocked" &&
            blockedId !== null &&
            noteId !== null &&
            noteId > blockedId,
          `${status} / note=${noteId} / block=${blockedId}`,
        );
});

test("处理备注：多次追加、最新一条、卡住前后判定与人工补登 PR", () => {
  const db = memory();
  createTask(db, { title: "浸泡验证" }, 100);
  assert.deepEqual(
    [
      getTask(db, "t1").note,
      getTask(db, "t1").note_by,
      getTask(db, "t1").note_at,
    ],
    [null, null, null],
  );
  addTaskNote(db, "t1", { text: "先查 CI", by: "a2" }, 101);
  advanceTask(db, "t1", { kind: "block" }, {}, { reason: "等结果" }, 101);
  assert.equal(getTask(db, "t1").processing, false, "同一毫秒按事件顺序比较");
  addTaskNote(db, "t1", { text: "等 fork 浸泡测试", by: "a2" }, 101);
  assert.equal(getTask(db, "t1").processing, true);
  assert.equal(getTask(db, "t1").note, "等 fork 浸泡测试");
  assert.equal(listTasks(db, {}).tasks[0]?.note_by, "a2");
  addTaskNote(db, "t1", { text: "  已提交复测  " }, 102);
  const latest = getTask(db, "t1");
  assert.deepEqual(
    [latest.note, latest.note_by, latest.note_at],
    ["已提交复测", "u1", 102],
  );
  assert.equal(
    latest.events.filter((event) => event.kind === "note").length,
    3,
  );
  assert.throws(
    () => addTaskNote(db, "t1", { text: "x".repeat(301) }),
    /300 字/,
  );
  assert.throws(() => addTaskNote(db, "t1", { text: "  " }), /不能为空/);
  assert.throws(
    () => addTaskNote(db, "t1", { text: "x", by: "bad name" }),
    /by:/,
  );
  assert.throws(() => addTaskNote(db, "t99", { text: "x" }), /不存在/);
  assert.throws(
    () => updateTask(db, "t1", { pr_url: "javascript:bad" }),
    /pr_url:/,
  );
  const pr = "https://github.com/fork-owner/atrium/pull/7";
  const patched = updateTask(db, "t1", { pr_url: pr }, 103);
  assert.equal(patched.pr_url, pr);
  assert.equal(patched.ci, "pending");
  assert.equal(getTask(db, "t1").events.at(-1)?.kind, "edited");
  db.close();
});

test("HTTP：任务备注需认证，列表和详情含当前备注", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-task-note-"));
  t.after(() => removeTemp(data));
  const guarded = await createApp({
    data: join(data, "guarded"),
  });
  try {
    const denied = await guarded.app.inject({
      method: "POST",
      url: "/api/tasks/t1/note",
      payload: { text: "x" },
      headers: { host: "127.0.0.1" },
    });
    assert.equal(denied.statusCode, 401);
  } finally {
    await guarded.app.close();
  }
  const { app } = await createApp({ data, auth: false });
  try {
    await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "待验证" },
    });
    const posted = await app.inject({
      method: "POST",
      url: "/api/tasks/t1/note",
      payload: { text: "等 fork" },
    });
    assert.equal(posted.statusCode, 200);
    assert.equal(posted.json().note_by, "u1");
    const forged = await app.inject({
      method: "POST",
      url: "/api/tasks/t1/note",
      payload: { text: "冒名", by: "a1" },
    });
    assert.equal(forged.statusCode, 403);
    const list = (await app.inject({ url: "/api/tasks" })).json().tasks[0];
    const show = (await app.inject({ url: "/api/tasks/t1" })).json();
    assert.deepEqual(
      [list.note, list.note_by, list.note_at],
      [show.note, show.note_by, show.note_at],
    );
    assert.equal(show.events.at(-1).kind, "note");
    const bad = await app.inject({
      method: "POST",
      url: "/api/tasks/t1/note",
      payload: { text: "x".repeat(301) },
    });
    assert.equal(bad.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("HTTP：五个接口走用户认证，校验报中文 400", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-tasks-"));
  t.after(() => removeTemp(data));
  const guarded = await createApp({
    data: join(data, "guarded"),
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

  const { app } = await createApp({ data, auth: false });
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
    assert.equal(tree.json().tasks[0].child_summary.todo, 1);
    const patched = await app.inject({
      method: "PATCH",
      url: "/api/tasks/2",
      headers,
      payload: { status: "done" },
    });
    assert.equal(patched.json().status, "done");
    const shown = await app.inject({ url: "/api/tasks/t2", headers });
    assert.equal(shown.json().events.at(-1).kind, "manual_set");
    const parentShown = await app.inject({ url: "/api/tasks/t1", headers });
    assert.equal(parentShown.json().child_summary.total, 1);
    assert.equal(parentShown.json().child_summary.done, 1);
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
  ) => ({
    ref,
    status,
    title,
    deliver: "pr",
    issue: null,
    worker: null,
    pr_url: null,
    ...extra,
    children,
  });
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
    "t1 [running] 目标 · pr",
    "  t2 [done] 子一 · pr · codex · https://github.com/o/r/pull/7",
    "    t4 [todo] 孙 · pr",
    "  t3 [failed] 子二 · pr",
  ]);
});

test("旧任务迁移后默认 PR 交付", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, parent_id INTEGER, title TEXT NOT NULL,
    brief_path TEXT, role TEXT, repo TEXT, status TEXT NOT NULL, worker TEXT, pid INTEGER,
    worktree TEXT, branch TEXT, pr_url TEXT, ci TEXT, result TEXT,
    created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, updated_at INTEGER NOT NULL)`);
  db.exec(
    "INSERT INTO tasks(id,title,status,created_at,updated_at) VALUES (1,'旧任务','todo',0,0)",
  );
  ensureTaskTables(db);
  assert.equal(getTask(db, "t1").deliver, "pr");
  assert.equal(getTask(db, "t1").issue, null);
  ensureTaskTables(db);
  db.close();
});
