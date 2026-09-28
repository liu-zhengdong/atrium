import { test } from "node:test";
import { addPoint } from "../server/org/points.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode, editDoc, editNode } from "../server/org/write.ts";
import { show, tree } from "../server/org/read.ts";
import { taskNode } from "../server/org/task-node.ts";
import { BRIEF_MAX, charterBrief, formatBrief } from "../server/org/brief.ts";
import {
  createTask,
  ensureTaskTables,
  getTask,
  updateTask,
} from "../server/tasks/ledger.ts";
import { buildPrompt } from "../server/tasks/prepare.ts";
import { prepareRun } from "../server/tasks/workspace.ts";
import { formatCounts, formatDoc } from "../cli/org.ts";
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
  node(db, { parent: "o2", slug: "安全", kind: "concern", name: "安全" });
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

test("章程要点：边界完整附上，超长先截父节点目标再截本节点目标，整段不超过 2000 字", () => {
  const boundaries = Array.from({ length: 17 }, (_, i) => ({
    summary: `${i}`.padEnd(80, "边"),
    param:
      i === 0 ? { key: "quota_reserve_percent" as const, value: 20 } : null,
  }));
  const input = {
    chain: ["组织", "Atrium", "runtime"],
    node: { ref: "o3", name: "runtime", goal: "本".repeat(300) },
    parent: { name: "Atrium", goal: "父".repeat(300) },
    boundaries,
  };
  const brief = formatBrief(input);
  const size = Array.from(brief.heading + brief.text).length;
  assert.equal(brief.heading, "章程要点（组织 → Atrium → runtime）");
  assert.ok(size <= BRIEF_MAX, `${size}`);
  for (const b of boundaries) assert.ok(brief.text.includes(b.summary));
  assert.ok(brief.text.includes("：至少 20%"));
  assert.ok(brief.text.includes("…（全文：atrium org show o3）"));
  assert.ok(
    brief.text.includes("本".repeat(300)),
    "只截父节点就够时本节点目标完整",
  );
  // 写入校验允许的上限（链上 summary 合计 1200 字）加两段 300 字目标仍放得下，不截
  const full = formatBrief({ ...input, boundaries: boundaries.slice(0, 15) });
  assert.ok(Array.from(full.heading + full.text).length <= BRIEF_MAX);
  assert.ok(full.text.includes("父".repeat(300)));
  const short = formatBrief({ ...input, boundaries: boundaries.slice(0, 2) });
  assert.ok(short.text.includes("父".repeat(300)), "不超长不截");
  assert.ok(short.text.startsWith("目标：Atrium——父"));
  // 边界已占满时两段目标都会被截掉
  const many = Array.from({ length: 22 }, () => ({
    summary: "边".repeat(80),
    param: null,
  }));
  const tight = formatBrief({ ...input, boundaries: many });
  assert.ok(Array.from(tight.heading + tight.text).length <= BRIEF_MAX);
  assert.ok(!tight.text.includes("父父"));
  assert.equal(tight.text.match(/边{80}/g)?.length, 22);
  const none = formatBrief({
    chain: ["组织"],
    node: { ref: "o1", name: "组织", goal: "" },
    boundaries: [],
  });
  assert.ok(!none.text.includes("目标"));
  assert.ok(none.text.includes("硬边界：无"));
});

test("派活提示词：节点任务附岗位正文、章程要点与投任务的专员说明", async () => {
  const db = setup();
  editDoc(
    db,
    "o1",
    "charter",
    {
      fields: { goal: "组织目标" },
      body: "",
      boundaries: [
        { id: "no-spend", summary: "不花钱" },
        {
          id: "quota-reserve",
          summary: "账号额度留给用户",
          param: { quota_reserve_percent: 20 },
        },
      ],
      reason: "根",
    } as never,
    "u1",
  );
  editDoc(
    db,
    "o2",
    "charter",
    { fields: { goal: "运行底座" }, body: "", reason: "目标" } as never,
    "u1",
  );
  editDoc(
    db,
    "o3",
    "charter",
    {
      fields: { goal: "派活不用人盯" },
      body: "# runtime 岗位正文",
      boundaries: [{ id: "no-stash", summary: "不用 git stash" }],
      reason: "正文",
    } as never,
    "u1",
  );
  editDoc(
    db,
    "o4",
    "charter",
    { fields: {}, body: "安全专员：查凭据", reason: "正文" } as never,
    "u1",
  );
  const brief = charterBrief(db, 3)!;
  assert.equal(brief.heading, "章程要点（组织 → Atrium → runtime）");
  assert.equal(
    brief.text,
    [
      "目标：Atrium——运行底座；runtime——派活不用人盯",
      "硬边界（任何情况都不能放开）：",
      "- 不花钱",
      "- 账号额度留给用户：至少 20%",
      "- 不用 git stash",
      "预算：本任务记在 runtime（o3）账上。",
      "碰到边界或预算不够：停下，在结果里写「需要上层决定：……」，不要绕过。",
    ].join("\n"),
  );
  addPoint(
    db,
    "o2",
    { text: "随时升级", why: "不等空闲", by: "u1 09-27" },
    "u1",
  );
  const task = getTask(db, createTask(db, { title: "修派活", from: "o4" }).ref);
  // 旧任务记在节点上（node_id）：派活附该节点的岗位正文与章程要点。
  db.prepare("UPDATE tasks SET node_id=3 WHERE id=?").run(task.id);
  Object.assign(task, { node_id: 3 });
  assert.equal(taskNode(db, task)?.body, "# runtime 岗位正文");
  const data = mkdtempSync(join(tmpdir(), "atrium-org-tasks-"));
  try {
    const prepared = await prepareRun(
      task,
      {
        worker: {
          tool: "claude",
          id: "claude",
          profile: { rules: {}, body: "" } as never,
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
      at("## 岗位说明\n\n# runtime 岗位正文") <
        at("## 章程要点（组织 → Atrium → runtime）"),
    );
    assert.ok(
      at("## 章程要点") <
        at(
          "## 投任务的专员说明\n\n本任务由 o4 安全 投来。\n\n安全专员：查凭据",
        ),
    );
    assert.ok(prompt.includes("- 不用 git stash"));
    // 全景位置与本节点及上级的要点（map context）附在章程要点同一段、硬边界之前（#322）。
    assert.ok(
      at(
        "## 章程要点（组织 → Atrium → runtime）\n\n全景位置：组织 → Atrium → runtime",
      ) < at("- [Atrium] 随时升级（为什么：不等空闲；u1 09-27 定）") &&
        at("- [Atrium] 随时升级") < at("硬边界（任何情况都不能放开）"),
    );
  } finally {
    removeTemp(data);
    db.close();
  }
  const plain = buildPrompt({ title: "旧任务", roleDoc: "旧岗位" });
  assert.ok(!plain.includes("章程要点"), "没有节点的任务照旧");
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

test("org show 章程：空字段省略，不显示 {}", () => {
  assert.deepEqual(formatDoc("章程", null), ["章程 r0：未填写"]);
  assert.deepEqual(formatDoc("章程", { rev: "r2", fields: {}, body: "" }), [
    "章程 r2：未填写",
  ]);
  assert.deepEqual(
    formatDoc("章程", {
      rev: "r3",
      fields: { goal: "目标一句", report: "", escalate: " " },
      body: "正文\n",
    }),
    ["章程 r3", "  目标：目标一句", "正文"],
  );
  for (const line of formatDoc("章程", { rev: "r1", fields: {}, body: "x" }))
    assert.ok(!line.includes("{}"));
});
