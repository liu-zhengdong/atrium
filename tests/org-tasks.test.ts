import { test } from "node:test";
import { addPoint } from "../server/org/points.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode } from "../server/org/write.ts";
import { show, tree } from "../server/org/read.ts";
import { formatContext } from "../server/map/context.ts";
import { createJobRole } from "../server/tasks/job-roles.ts";
import {
  createTask,
  ensureTaskTables,
  getTask,
} from "../server/tasks/ledger.ts";
import { prepareRun } from "../server/tasks/workspace.ts";
import { formatCounts } from "../cli/org.ts";
import { removeTemp } from "./temp-dir.ts";

const ATRIUM = "/repo/atrium";
const OPENQUOTA = "/repo/openquota";
const node = (db: DatabaseSync, input: Record<string, unknown>) =>
  addNode(db, { reason: "创建", ...input } as never, "u1");

/** 组织 o1；Atrium o2（挂 /repo/atrium）下 runtime o3、安全 o4；OpenQuota o5（挂 /repo/openquota）下 runtime o6。 */
function setup() {
  const db = new DatabaseSync(":memory:");
  ensureOrgTables(db);
  ensureTaskTables(db);
  node(db, { slug: "org", kind: "org", name: "组织" });
  node(db, {
    parent: "o1",
    slug: "atrium",
    kind: "project",
    name: "Atrium",
    repos: [ATRIUM],
  });
  node(db, { parent: "o2", slug: "runtime", kind: "module", name: "runtime" });
  // 旧库里的关注点（已下线，不能再建）：直接写进表。
  db.prepare(
    "INSERT INTO org_nodes(parent_id,kind,slug,name,created_at,updated_at) VALUES(2,'concern','安全','安全',1,1)",
  ).run();
  node(db, {
    parent: "o1",
    slug: "openquota",
    kind: "project",
    name: "OpenQuota",
    repos: [`${OPENQUOTA}/`],
  });
  node(db, { parent: "o5", slug: "runtime", kind: "module", name: "runtime" });
  return db;
}

test("规矩段：根到本部门按层、同层按排序；有字数上限，放不下先去掉「为什么」再从末尾截", () => {
  const points = [
    {
      name: "组织",
      points: [
        { text: "不花钱", why: "底线", check: null },
        { text: "先求简洁", why: "用户原则第一条", check: null },
      ],
    },
    { name: "Atrium", points: [] },
    {
      name: "runtime",
      points: [
        {
          text: "重启不丢执行者",
          why: "升级随时可做",
          check: "tests/recovery.test.ts",
        },
      ],
    },
  ];
  const full = formatContext({ points, skills: ["code-structure"] }, "o3");
  assert.equal(full.truncated, false);
  assert.equal(
    full.text,
    [
      "规矩（从上到下越靠前越重要，冲突时靠前的优先）：",
      "[组织]",
      "1. 不花钱（底线）",
      "2. 先求简洁（用户原则第一条）",
      "[runtime]",
      "1. 重启不丢执行者（升级随时可做）（检查：tests/recovery.test.ts）",
      "技能：code-structure（派活时已挂载）",
    ].join("\n"),
  );
  // 放不下「为什么」时先去掉它，规矩本身一条不少。
  const tight = formatContext({ points }, "o3", 110);
  assert.equal(tight.truncated, false);
  assert.ok(tight.text.includes("1. 不花钱\n"));
  assert.ok(tight.text.includes("重启不丢执行者（检查"));
  // 再放不下就从末尾截，给全文命令。
  const cut = formatContext({ points }, "o3", 60);
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.endsWith("…（全文：atrium map context o3）"));
  assert.ok(Array.from(cut.text).length <= 60);
  assert.deepEqual(formatContext({ points: [] }, "o1"), {
    text: "",
    truncated: false,
  });
});

test("派活提示词：只附分工、归属部门链上的规矩与挂载的技能；不再附章程、岗位正文与叮嘱", async () => {
  const db = setup();
  addPoint(db, "o1", { text: "不花钱", why: "底线", by: "u1" }, "u1");
  addPoint(
    db,
    "o2",
    { text: "随时升级", why: "不等空闲", by: "u1 09-27" },
    "u1",
  );
  addPoint(db, "o5", { text: "别处的规矩", why: "w", by: "u1" }, "u1");
  createJobRole(db, {
    name: "后端",
    description: "负责服务与命令行",
    checks: ["pr_exists"],
  });
  const task = getTask(
    db,
    createTask(db, { title: "修派活", part: "o3", by: "后端" }).ref,
  );
  const data = mkdtempSync(join(tmpdir(), "atrium-org-tasks-"));
  try {
    const prepared = await prepareRun(
      task,
      {
        worker: {
          tool: "claude",
          id: "claude",
          profile: { rules: {}, body: "旧叮嘱" } as never,
        },
        risk: "low",
      },
      { db, data, env: {} },
    );
    const prompt = readFileSync(prepared.promptFile, "utf8");
    const at = (text: string) => {
      const index = prompt.indexOf(text);
      assert.ok(index >= 0, text);
      return index;
    };
    assert.ok(
      at("## 分工\n\n干活的专员：后端——负责服务与命令行；交付关卡：pr_exists") <
        at("## 规矩\n\n规矩（从上到下越靠前越重要"),
    );
    assert.ok(
      at("[组织]\n1. 不花钱（底线）\n[Atrium]\n1. 随时升级（不等空闲）") <
        at("## 通用约束"),
    );
    for (const gone of ["别处的规矩", "章程", "岗位说明", "旧叮嘱", "全景位置"])
      assert.ok(!prompt.includes(gone), gone);
  } finally {
    removeTemp(data);
    db.close();
  }
});

test("org tree 按子树汇总在做／卡住，旧关注点不再列出；org show 列手上的任务", () => {
  const db = setup();
  const status = db.prepare("UPDATE tasks SET status=? WHERE id=?");
  const add = (part: string, s: string, from?: string) =>
    status.run(s, createTask(db, { title: `${part}-${s}`, part, from }).id);
  add("o3", "running", "o4");
  add("o3", "running");
  add("o3", "blocked");
  add("o3", "done");
  add("o6", "todo", "o4");
  const rows = new Map(tree(db).map((n) => [n.ref, n]));
  assert.deepEqual(rows.get("o3")!.tasks, { todo: 0, running: 2, blocked: 1 });
  assert.deepEqual(rows.get("o2")!.tasks, { todo: 0, running: 2, blocked: 1 });
  assert.deepEqual(rows.get("o1")!.tasks, { todo: 1, running: 2, blocked: 1 });
  assert.equal(rows.has("o4"), false);
  assert.equal(
    formatCounts(rows.get("o1")!.tasks, rows.get("o1")!.sent),
    " · 在做 2 · 卡住 1 · 待办 1",
  );
  assert.equal(formatCounts(rows.get("o6")!.sent, rows.get("o6")!.sent), "");
  const recent = (show(db, "o3") as { recent_tasks: { ref: string }[] })
    .recent_tasks;
  assert.deepEqual(
    recent.map((t) => t.ref),
    ["t3", "t2", "t1", "t4"],
    "未结的在前",
  );
  db.close();
});
