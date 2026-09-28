import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode, editFields, editNode } from "../server/org/write.ts";
import { history, show, tree } from "../server/org/read.ts";
import { formatOrgChanges } from "../cli/org.ts";
import {
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
  const cases: [unknown, RegExp][] = [
    [{ unknown: "x" }, /fields.unknown.*未知/],
    [{ goal: "x" }, /fields.goal.*未知/],
    [{ what: "字".repeat(301) }, /fields.what.*300/],
    [{ now: 1 }, /fields.now.*文本/],
    [{ toString: "x" }, /fields.toString.*未知/],
  ];
  for (const [value, expected] of cases)
    assert.throws(() => validateFields(value), expected);
  assert.deepEqual(validateFields({ what: "是什么", uses: ["看"] }), {
    what: "是什么",
    uses: ["看"],
  });
});
test("权限、层级、人话字段不留修订、节点修订的乐观并发与差异", () => {
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
  // 人话字段：根只有用户能改；leader 链可改下层，只存当前值、不留修订。
  assert.throws(() => editFields(db, "org", { what: "x" }, "a1"), /无权限/);
  editFields(db, "atrium/runtime", { what: "跑通" }, "a1");
  assert.equal(
    (show(db, "o3") as { overview: { what: string } }).overview.what,
    "跑通",
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM org_revisions WHERE node_id=? AND target<>'node'",
      )
      .get(module.id)!.n,
    0,
  );
  // 节点修订：乐观并发与差异。
  const renamed = editNode(
    db,
    "o3",
    { name: "运行时", rev: "r1", reason: "改名" },
    "a1",
  );
  assert.equal(renamed.rev, "r2");
  assert.throws(
    () => editNode(db, "o3", { name: "旧", rev: "r1", reason: "旧版" }, "a2"),
    /history/,
  );
  assert.deepEqual(
    (
      history(db, "o3", { rev: "r2" }) as {
        changes: Record<string, unknown>;
      }
    ).changes.name,
    { before: "runtime", after: "运行时" },
  );
  assert.equal(
    (history(db, "o3", { limit: 1 }) as { has_more: boolean }).has_more,
    true,
  );
  assert.equal(tree(db).length, 3);
  db.close();
});
test("修订差异的人读格式与边界", () => {
  assert.equal(
    formatOrgChanges({ name: { before: "旧名", after: "新名" } }),
    "name：旧名→ 新名",
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
  const archived = editNode(
    db,
    `o${module.id}`,
    { archive: true, reason: "搁置" },
    "a1",
  );
  assert.ok(archived.archived_at);
  assert.throws(
    () => editFields(db, `o${module.id}`, { what: "越过归档" }, "a2"),
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
