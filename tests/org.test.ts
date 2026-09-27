import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureOrgTables } from "../server/org/schema.ts";
import {
  addNode,
  editDoc,
  editNode,
  importOrg,
  revertDoc,
} from "../server/org/write.ts";
import { history, show, tree } from "../server/org/read.ts";
import { formatOrgChanges } from "../cli/org.ts";
import { roleCharter } from "../server/org/role.ts";
import {
  exportDocument,
  parseDocument,
  validateBody,
  validateFields,
  validateReason,
  validateSlug,
  validParent,
} from "../server/org/validate.ts";

const setup = () => {
  const db = new DatabaseSync(":memory:");
  ensureOrgTables(db);
  return db;
};
const seed = (db: DatabaseSync) => {
  const root = addNode(
    db,
    { slug: "org", kind: "org", name: "组织", reason: "创建" },
    "u1",
  );
  const project = addNode(
    db,
    {
      parent: `o${root.id}`,
      slug: "atrium",
      kind: "project",
      name: "Atrium",
      leader: "a1",
      reason: "创建",
    },
    "u1",
  );
  const module = addNode(
    db,
    {
      parent: `o${project.id}`,
      slug: "runtime",
      kind: "module",
      name: "runtime",
      leader: "a2",
      reason: "创建",
    },
    "a1",
  );
  return { root, project, module };
};
test("四表自愈、约束与短号不复用", () => {
  const db = setup();
  ensureOrgTables(db);
  for (const table of [
    "org_nodes",
    "org_node_repos",
    "org_docs",
    "org_revisions",
  ])
    assert.ok(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table),
    );
  const { root } = seed(db);
  assert.equal(root.id, 1);
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO org_nodes(kind,slug,name,created_at,updated_at) VALUES('org','other','另一根',1,1)",
      )
      .run(),
  );
  assert.throws(() =>
    db.prepare("DELETE FROM org_nodes WHERE id=?").run(root.id),
  );
  assert.throws(() =>
    db
      .prepare("UPDATE org_revisions SET reason='改历史' WHERE node_id=?")
      .run(root.id),
  );
  assert.throws(() =>
    db.prepare("DELETE FROM org_revisions WHERE node_id=?").run(root.id),
  );
  db.close();
});
test("validate 的每类拒绝规则与合法输入", () => {
  assert.equal(validateSlug("安全"), "安全");
  for (const bad of ["", "A", "a/b", "a".repeat(41)])
    assert.throws(() => validateSlug(bad), /slug/);
  assert.throws(() => validateReason(" "), /reason/);
  assert.throws(() => validateReason("字".repeat(501)), /reason/);
  assert.equal(validParent("org", "project"), true);
  for (const [parent, child] of [
    ["org", "module"],
    ["concern", "module"],
    ["project", "project"],
  ] as const)
    assert.equal(validParent(parent, child), false);
  const cases: ["charter" | "card", unknown, RegExp][] = [
    ["charter", { unknown: "x" }, /charter.unknown.*未知/],
    ["charter", { goal: "字".repeat(301) }, /charter.goal.*300/],
    ["charter", { report: 1 }, /charter.report.*文本/],
    ["charter", { escalate: "字".repeat(201) }, /charter.escalate.*200/],
    ["card", { unknown: 1 }, /card.unknown.*未知/],
    ["card", { status: "字".repeat(301) }, /card.status.*300/],
    ["card", { owns: Array(11).fill("x") }, /card.owns.*10/],
    ["card", { accepts: "x" }, /card.accepts.*列表/],
    ["card", { asks: Array(6).fill("x") }, /card.asks.*5/],
    [
      "card",
      { commitments: Array(11).fill({ id: "x", text: "x" }) },
      /card.commitments.*10/,
    ],
    [
      "card",
      { commitments: [{ id: "x", text: "x", oops: 1 }] },
      /card.commitments.*oops/,
    ],
    [
      "card",
      { commitments: [{ id: "x", text: "x", due: "today" }] },
      /card.commitments.*due/,
    ],
  ];
  for (const [doc, value, expected] of cases)
    assert.throws(() => validateFields(doc, value), expected);
  assert.throws(() => validateBody("字".repeat(6000)), /body.*16 KB/);
  assert.throws(() => validateBody(42), /body.*文本/);
  assert.throws(
    () => validateFields("charter", { toString: "x" }),
    /charter.toString.*未知/,
  );
  assert.throws(
    () =>
      validateFields("card", {
        commitments: [{ id: "x", text: "x", due: "2026-02-30" }],
      }),
    /due/,
  );
  assert.deepEqual(
    parseDocument(
      "---\nowns:\n  - server/\naccepts:\n  - 运行时\ncommitments:\n  - id: c1\n    text: 验收\n---\n正文",
      "card",
    ),
    {
      fields: {
        owns: ["server/"],
        accepts: ["运行时"],
        commitments: [{ id: "c1", text: "验收" }],
      },
      body: "正文",
    },
  );
  assert.deepEqual(
    validateFields("card", {
      owns: ["server"],
      commitments: [{ id: "c1", text: "完成", due: "2026-09-30" }],
    }),
    {
      owns: ["server"],
      commitments: [{ id: "c1", text: "完成", due: "2026-09-30" }],
    },
  );
  for (const bad of [
    "goal: x\n正文",
    "---\ngoal: x\n正文",
    "---\ngoal: [bad\n---\n正文",
    "---\ngoal: x\ngoal: y\n---\n正文",
    "---\nfoo: x\n---\n正文",
  ])
    assert.throws(() => parseDocument(bad, "charter"));
});
test("权限、层级、乐观并发、修订追加与导出写回", () => {
  const db = setup();
  const { root, project, module } = seed(db);
  assert.throws(
    () =>
      addNode(
        db,
        {
          parent: `o${root.id}`,
          slug: "bad",
          kind: "module",
          name: "bad",
          reason: "错层",
        },
        "u1",
      ),
    /kind/,
  );
  assert.throws(
    () =>
      addNode(
        db,
        {
          parent: `o${project.id}`,
          slug: "runtime",
          kind: "module",
          name: "same",
          reason: "重名",
        },
        "u1",
      ),
    /slug/,
  );
  assert.throws(
    () =>
      editDoc(
        db,
        "org",
        "charter",
        { fields: { goal: "x" }, body: "", reason: "越权" },
        "a1",
      ),
    /无权限/,
  );
  assert.throws(
    () =>
      editDoc(
        db,
        "atrium/runtime",
        "card",
        { fields: { status: "x" }, body: "", reason: "越权" },
        "a3",
      ),
    /无权限/,
  );
  const first = editDoc(
    db,
    "atrium/runtime",
    "charter",
    {
      fields: { goal: "跑通", report: "每周" },
      body: "# 正文\n",
      rev: "r0",
      reason: "初稿",
    },
    "a1",
  );
  assert.equal(first.rev, "r1");
  assert.throws(
    () =>
      editDoc(
        db,
        "o3",
        "charter",
        { fields: { goal: "覆盖" }, body: "", rev: "r0", reason: "旧版" },
        "a2",
      ),
    /history/,
  );
  assert.equal(
    (show(db, "o3") as { charter: { rev: string } }).charter.rev,
    "r1",
  );
  const exported = (show(db, "o3", "charter") as { raw: string }).raw;
  assert.deepEqual(parseDocument(exported, "charter"), {
    fields: { goal: "跑通", report: "每周" },
    body: "# 正文\n",
    boundaries: [],
  });
  const parsed = parseDocument(exported, "charter");
  editDoc(db, "o3", "charter", { ...parsed, rev: "r1", reason: "写回" }, "a2");
  const reverted = revertDoc(db, "o3", "charter", "r1", "回退", "a1");
  assert.equal(reverted.rev, "r3");
  assert.equal((show(db, "o3", "charter") as { raw: string }).raw, exported);
  const rows = db
    .prepare(
      "SELECT rev FROM org_revisions WHERE node_id=? AND target='charter' ORDER BY rev",
    )
    .all(module.id);
  assert.deepEqual(
    rows.map((r) => r.rev),
    [1, 2, 3],
  );
  assert.equal(
    (
      history(db, "o3", { target: "charter", rev: "r1" }) as {
        changes: Record<string, unknown>;
      }
    ).changes["fields.goal"] !== undefined,
    true,
  );
  assert.equal(
    (history(db, "o3", { limit: 1 }) as { has_more: boolean }).has_more,
    true,
  );
  assert.equal(tree(db).length, 3);
  db.close();
});
test("导入仅预览、重复 apply 不重复建", () => {
  const db = setup();
  const input = {
    charter: { fields: { goal: "Atrium 目标" }, body: "## 硬边界\n不花钱" },
    repo: "/tmp/repo",
    atrium_goal: "项目目标",
    docs: [
      {
        kind: "module" as const,
        slug: "runtime",
        name: "runtime",
        source: ".agents/modules/runtime.md",
        body: "# runtime\n岗位正文",
      },
    ],
    apply: false,
  };
  assert.equal(importOrg(db, input, "u1").preview, true);
  assert.equal(tree(db).length, 0);
  const applied = importOrg(db, { ...input, apply: true }, "u1");
  assert.ok("created" in applied && applied.created);
  const count = tree(db).length;
  const repeated = importOrg(db, { ...input, apply: true }, "u1");
  assert.equal("created" in repeated ? repeated.created : null, 0);
  assert.equal(tree(db).length, count);
  assert.deepEqual(repeated.plan, []);
  assert.equal(
    (history(db, "o4", { target: "charter" }) as { items: unknown[] }).items
      .length,
    1,
  );
  assert.equal(
    (show(db, "atrium/runtime") as { charter: { body: string } }).charter.body,
    "# runtime\n岗位正文",
  );
  assert.deepEqual(roleCharter(db, "atrium/runtime"), {
    body: "# runtime\n岗位正文",
    ref: "o4",
  });
  assert.deepEqual(roleCharter(db, "modules/runtime"), {
    body: "# runtime\n岗位正文",
    ref: "o4",
  });
  assert.deepEqual(roleCharter(db, "o4"), {
    body: "# runtime\n岗位正文",
    ref: "o4",
  });
  assert.equal(roleCharter(db, "modules/other"), undefined);
  const changed = importOrg(
    db,
    { ...input, docs: [{ ...input.docs[0]!, body: "更新正文" }], apply: true },
    "u1",
  );
  assert.deepEqual(changed.plan, ["更新 o4 atrium/runtime 章程 r2"]);
  assert.equal(
    (
      history(db, "o4", { target: "charter", rev: "r2" }) as {
        revision: { reason: string };
      }
    ).revision.reason,
    "从 .agents 导入",
  );
  assert.throws(
    () =>
      importOrg(
        db,
        { ...input, docs: [{ ...input.docs[0]!, body: "字".repeat(6000) }] },
        "u1",
      ),
    /runtime\.md.*16 KB/,
  );
  const project = show(db, "atrium");
  assert.equal(
    "charter" in project ? project.charter?.fields.goal : null,
    "项目目标",
  );
  assert.equal(
    (show(db, "o1") as { charter: { body: string } }).charter.body,
    "## 硬边界\n不花钱",
  );
  db.close();
});

test("修订差异的人读格式与边界", () => {
  assert.equal(
    formatOrgChanges({
      "fields.goal": { before: null, after: "派活闭环不需要人盯" },
      body: { before: "旧", after: "新", diff: "- 旧\n+ 新" },
    }),
    "goal：（空）→ 派活闭环不需要人盯\n正文：\n- 旧\n+ 新",
  );
  const long = Array.from({ length: 90 }, (_, i) => `+ ${i}`).join("\n");
  assert.match(
    formatOrgChanges({ body: { before: "", after: "", diff: long } }),
    /省略 10 行/,
  );
  assert.equal(
    formatOrgChanges({
      leader: { before: null, after: "u1" },
      doc_path: { before: null, after: ".agents/modules/runtime.md" },
    }),
    "leader：（空）→ 你",
  );
});

test("节点只归档、移动有层级与深度限制", () => {
  const db = setup();
  const { project, module } = seed(db);
  const renamed = editNode(
    db,
    `o${module.id}`,
    {
      slug: "engine",
      name: "引擎",
      repos: ["/tmp/atrium"],
      reason: "更新岗位",
    },
    "a1",
  );
  assert.equal(renamed.slug, "engine");
  assert.deepEqual(renamed.repos, ["/tmp/atrium"]);
  assert.equal("doc_path" in show(db, "atrium/engine"), false);
  assert.throws(
    () =>
      editNode(
        db,
        `o${module.id}`,
        {
          doc_path: ".agents/modules/runtime.md",
          reason: "旧字段",
        } as Parameters<typeof editNode>[2],
        "a1",
      ),
    /doc_path 已停用/,
  );
  const archived = editNode(
    db,
    `o${module.id}`,
    { archive: true, reason: "搁置" },
    "a1",
  );
  assert.ok(archived.archived_at);
  assert.throws(
    () =>
      editDoc(
        db,
        `o${module.id}`,
        "card",
        { fields: {}, body: "", reason: "越过归档" },
        "a2",
      ),
    /已归档/,
  );
  assert.throws(
    () =>
      addNode(
        db,
        {
          parent: `o${module.id}`,
          slug: "child",
          kind: "module",
          name: "child",
          reason: "错误",
        },
        "u1",
      ),
    /已归档/,
  );
  let parent = `o${project.id}`;
  for (let depth = 3; depth <= 8; depth++) {
    const node = addNode(
      db,
      {
        parent,
        slug: `level-${depth}`,
        kind: "module",
        name: `L${depth}`,
        reason: "扩展",
      },
      "u1",
    );
    parent = `o${node.id}`;
  }
  assert.throws(
    () =>
      addNode(
        db,
        {
          parent,
          slug: "too-deep",
          kind: "module",
          name: "too deep",
          reason: "扩展",
        },
        "u1",
      ),
    /深度 8/,
  );
  assert.throws(
    () => editNode(db, `o${project.id}`, { parent, reason: "环" }, "u1"),
    /parent/,
  );
  db.close();
});
