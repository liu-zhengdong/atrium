import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode, editDoc, editNode, revertDoc } from "../server/org/write.ts";
import { history, show, tree } from "../server/org/read.ts";
import {
  checkShares,
  parseShares,
  type ShareNode,
} from "../server/org/shares.ts";
import { parseDocument } from "../server/org/validate.ts";
import { readQuotaReservePercent } from "../server/tasks/budget.ts";
import { formatBudget } from "../cli/org.ts";

const entry = (
  id: number,
  parent: number | null,
  quota?: number,
): ShareNode => ({
  id,
  parent,
  name: `节点${id}`,
  shares:
    quota === undefined
      ? []
      : [{ dim: "quota", scope: "claude", amount: quota }],
});
test("份额纯函数：兄弟超额、父缩额、共享池、具体账号覆盖通配符", () => {
  const list = [
    entry(1, null),
    entry(2, 1, 40),
    entry(3, 2, 10),
    entry(4, 2, 15),
    entry(5, 2),
  ];
  assert.deepEqual(checkShares(list, { quota: 80, money: 0 }, ["claude"]), []);
  assert.equal(
    checkShares(
      [
        list[0]!,
        {
          ...list[1]!,
          shares: [{ dim: "quota", scope: "claude", amount: 20 }],
        },
        ...list.slice(2),
      ],
      { quota: 80, money: 0 },
      ["claude"],
    )[0]?.field,
    "budget.quota.claude",
  );
  assert.equal(
    checkShares(
      [entry(1, null), entry(2, 1, 45), entry(3, 1, 40)],
      { quota: 80, money: 0 },
      ["claude"],
    )[0]?.field,
    "budget.quota.claude",
  );
  assert.equal(
    checkShares(
      [
        entry(1, null),
        { ...entry(2, 1), shares: [{ dim: "money", scope: "", amount: 1 }] },
      ],
      { quota: 80, money: 0 },
    )[0]?.field,
    "budget.money",
  );
  assert.deepEqual(
    parseShares({ quota: { "*": 20, claude: 30 }, disk: 10 }).entries.length,
    3,
  );
  assert.deepEqual(
    parseShares({ quota: { bad: -1 }, money: "1", extra: 4 }).problems.map(
      (p) => p.field,
    ),
    ["budget.quota.bad", "budget.money", "budget.extra"],
  );
});

test("章程份额事务、展示、修订与数据库保留额", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  ensureOrgTables(db);
  const root = addNode(
    db,
    { slug: "org", kind: "org", name: "组织", reason: "建树" },
    "u1",
  );
  const project = addNode(
    db,
    {
      parent: `o${root.id}`,
      slug: "game",
      kind: "project",
      name: "游戏",
      reason: "建项目",
    },
    "u1",
  );
  const physics = addNode(
    db,
    {
      parent: `o${project.id}`,
      slug: "physics",
      kind: "module",
      name: "物理",
      reason: "建模块",
    },
    "u1",
  );
  const render = addNode(
    db,
    {
      parent: `o${project.id}`,
      slug: "render",
      kind: "module",
      name: "渲染",
      reason: "建模块",
    },
    "u1",
  );
  const other = addNode(
    db,
    {
      parent: `o${root.id}`,
      slug: "other",
      kind: "project",
      name: "其他",
      reason: "建项目",
    },
    "u1",
  );
  const update = (id: number, budget: unknown, boundaries?: unknown) =>
    editDoc(
      db,
      `o${id}`,
      "charter",
      { fields: {}, body: "", budget, boundaries, reason: "分配份额" },
      "u1",
    );
  update(root.id, {}, [
    {
      id: "quota-reserve",
      summary: "留给用户",
      param: { quota_reserve_percent: 20 },
    },
    { id: "money", summary: "不花钱", param: { money_yuan_max: 0 } },
  ]);
  update(project.id, { quota: { claude: 40 } });
  update(physics.id, { quota: { claude: 15 } });
  update(render.id, { quota: { claude: 10 } });
  assert.match(
    (show(db, `o${physics.id}`, "charter") as { raw: string }).raw,
    /budget:[\s\S]*claude: 15/,
  );
  assert.equal(
    (
      show(db, `o${physics.id}`) as {
        budget: { quota: { scope: string; amount: number }[] };
      }
    ).budget.quota.find((q) => q.scope === "claude")?.amount,
    15,
  );
  assert.equal(
    tree(db)
      .find((n) => n.id === physics.id)
      ?.budget?.quota.find((q) => q.scope === "claude")?.amount,
    15,
  );
  assert.match(
    formatBudget(tree(db).find((n) => n.id === render.id)!.budget!),
    /claude 份额 10/,
  );
  assert.match(
    formatBudget(tree(db).find((n) => n.id === other.id)!.budget!),
    /claude 共享池 40/,
  );
  assert.rejects(
    async () => update(render.id, { quota: { claude: 30 } }),
    /budget.quota.claude.*超出 5/,
  );
  assert.throws(
    () => update(project.id, { quota: { claude: 20 } }),
    /budget.quota.claude/,
  );
  assert.throws(() => update(physics.id, { money: 1 }), /budget.money/);
  assert.equal(
    (show(db, `o${render.id}`) as { charter: { rev: string } }).charter.rev,
    "r1",
  );
  assert.equal(readQuotaReservePercent(db, physics.id), 20);
  update(physics.id, { quota: { claude: 15 } }, [
    { id: "quota-reserve", param: { quota_reserve_percent: 25 } },
  ]);
  assert.equal(readQuotaReservePercent(db, physics.id), 25);
  assert.equal(readQuotaReservePercent(db, render.id), 20);
  const diff = history(db, `o${physics.id}`, { rev: "r1", target: "charter" });
  assert.equal(
    (diff as { changes: Record<string, unknown> }).changes[
      "budget.quota.claude"
    ] !== undefined,
    true,
  );
  update(physics.id, { quota: { claude: 10 } });
  revertDoc(db, `o${physics.id}`, "charter", "r1", "恢复", "u1");
  assert.equal(
    (
      show(db, `o${physics.id}`) as {
        budget: { quota: { scope: string; amount: number }[] };
      }
    ).budget.quota.find((q) => q.scope === "claude")?.amount,
    15,
  );
  assert.equal(
    parseDocument(
      (show(db, `o${physics.id}`, "charter") as { raw: string }).raw,
      "charter",
    ).budget !== undefined,
    true,
  );
  assert.throws(
    () =>
      editNode(
        db,
        `o${physics.id}`,
        { parent: `o${root.id}`, reason: "错误移动" },
        "u1",
      ),
    /parent 层级不合法/,
  );
});
