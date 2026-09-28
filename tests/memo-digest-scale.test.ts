import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ensureOrgTables } from "../server/org/schema.ts";
import { nodes } from "../server/org/model.ts";
import { ensureMemoTables } from "../server/memos/store.ts";
import {
  DIGEST_LIMITS,
  decisionDigest,
  decisionSize,
  digestDecisions,
  nodeScope,
  ownerScope,
  pickSql,
  totalSql,
} from "../server/memos/digest.ts";
import {
  views,
  type DecisionScope,
  type Row,
} from "../server/memos/decisions.ts";

/**
 * 决定摘要的规模回归（t221）：数据量固定，不靠本机计时判过。
 * - 结果和「全部读出来再按规则挑」的朴素写法逐条一致（原则 + 最近 N 条、字数上限、总数）；
 * - 查询条数是常数，不随决定条数变；
 * - 查询计划不整表扫 decisions：按份走部分索引 decisions_active，挂节点的一路从 decision_nodes 索引进。
 */

const OWNERS = ["u1", "secretary", "a1", "a2", "a3"];

/** 组织树：o1 组织，o2–o4 项目，o5–o13 模块（每个项目下三个）；a1 负责 o2。 */
function seed(size: number) {
  const db = new DatabaseSync(":memory:");
  ensureOrgTables(db);
  ensureMemoTables(db);
  const node = db.prepare(
    "INSERT INTO org_nodes(id,parent_id,kind,slug,name,leader,created_at,updated_at) VALUES(?,?,?,?,?,?,0,0)",
  );
  node.run(1, null, "org", "org", "组织", null);
  for (let i = 2; i <= 4; i++)
    node.run(i, 1, "project", `p${i}`, `项目${i}`, i === 2 ? "a1" : null);
  for (let i = 5; i <= 13; i++)
    node.run(
      i,
      2 + Math.floor((i - 5) / 3),
      "module",
      `m${i}`,
      `模块${i}`,
      null,
    );
  const insert = db.prepare(
    "INSERT INTO decisions(owner,decided_on,decided_by,text,why,principle,settled_point,created_at) VALUES(?,?,?,?,?,?,?,?)",
  );
  const link = db.prepare(
    "INSERT OR IGNORE INTO decision_nodes(decision_id,node_id) VALUES(?,?)",
  );
  db.exec("BEGIN");
  for (let i = 1; i <= size; i++) {
    const owner = OWNERS[i % OWNERS.length]!;
    // 补记的旧决定：日期顺序和短号顺序不一致，同一天也有好几条。
    const day = `2026-${String(1 + ((i * 7) % 9)).padStart(2, "0")}-${String(1 + ((i * 5) % 28)).padStart(2, "0")}`;
    const id = Number(
      insert.run(
        owner,
        day,
        owner,
        `第 ${i} 条决定${"很长".repeat(i % 5)}`,
        `原因 ${i}`,
        i % 37 === 0 ? 1 : 0,
        i % 13 === 0 ? 1 : null,
        i,
      ).lastInsertRowid,
    );
    if (i % 4 !== 0) link.run(id, 1 + (i % 13));
    if (i % 6 === 0) link.run(id, 1 + ((i * 3) % 13));
  }
  // 推翻：每 11 条的前一条被它推翻。
  db.exec(
    "UPDATE decisions SET superseded_by=id+1,superseded_at=1 WHERE (id+1)%11=0",
  );
  db.exec("COMMIT");
  return db;
}

/** 朴素写法：全部读出来，在内存里按摘要规则挑（只在测试里当参照）。 */
function naive(
  db: DatabaseSync,
  scope: DecisionScope,
  limits: typeof DIGEST_LIMITS,
) {
  const linked = new Map<number, number[]>();
  for (const r of db
    .prepare("SELECT decision_id,node_id FROM decision_nodes")
    .all() as { decision_id: number; node_id: number }[])
    linked.set(r.decision_id, [
      ...(linked.get(r.decision_id) ?? []),
      r.node_id,
    ]);
  const owners = new Set(scope.owners ?? []);
  const scoped = new Set(scope.nodes ?? []);
  const active = (db.prepare("SELECT * FROM decisions").all() as Row[])
    .filter((r) => r.superseded_by === null && r.settled_point === null)
    .filter(
      (r) =>
        owners.has(r.owner) ||
        (linked.get(r.id) ?? []).some((n) => scoped.has(n)),
    )
    .sort((a, b) =>
      a.decided_on === b.decided_on
        ? b.id - a.id
        : a.decided_on < b.decided_on
          ? 1
          : -1,
    );
  const principles = views(
    db,
    active.filter((r) => r.principle === 1).slice(0, limits.principles),
  );
  const recent = views(
    db,
    active.filter((r) => r.principle === 0).slice(0, limits.recent),
  );
  const { shown, omitted } = digestDecisions(
    principles,
    recent,
    active.length,
    decisionSize,
    limits,
  );
  return { refs: shown.map((d) => d.ref), total: active.length, omitted };
}

function scopes(db: DatabaseSync): [string, DecisionScope][] {
  const list = nodes(db);
  return [
    ["秘书", ownerScope("secretary", list)],
    ["用户", ownerScope("u1", list)],
    ["leader a1", ownerScope("a1", list)],
    ["没负责部分的 leader a3", ownerScope("a3", list)],
    ["节点 o7 及上级", { nodes: nodeScope(list, [7]) }],
    ["空范围", {}],
  ];
}

test("摘要：库里按索引挑的和全部读出来再挑的逐条一致（原则、最近、字数上限、总数）", () => {
  const db = seed(1200);
  const tight = { recent: 6, chars: 500, principles: 4 };
  for (const limits of [DIGEST_LIMITS, tight])
    for (const [label, scope] of scopes(db)) {
      const got = decisionDigest(db, scope, limits);
      const want = naive(db, scope, limits);
      assert.deepEqual(
        {
          refs: got.decisions.map((d) => d.ref),
          total: got.total,
          omitted: got.omitted,
        },
        want,
        `${label} ${JSON.stringify(limits)}`,
      );
      assert.equal(
        got.principles,
        got.decisions.filter((d) => d.principle).length,
      );
    }
  // 数据确实覆盖到了：有原则、有被截掉的、秘书那份含用户的。
  const secretary = decisionDigest(db, ownerScope("secretary", nodes(db)));
  assert(secretary.principles > 0 && secretary.omitted > 0);
  assert(secretary.decisions.some((d) => d.owner === "u1"));
});

test("摘要的查询条数是常数：300 条和 3000 条决定时一样多", () => {
  const count = (size: number) => {
    const db = seed(size);
    const list = nodes(db);
    const prepare = db.prepare.bind(db);
    let n = 0;
    db.prepare = ((sql: string) => {
      n++;
      return prepare(sql);
    }) as typeof db.prepare;
    const out: Record<string, number> = {};
    for (const owner of ["secretary", "u1", "a1"]) {
      n = 0;
      decisionDigest(db, ownerScope(owner, list));
      out[owner] = n;
    }
    return out;
  };
  const small = count(300);
  assert.deepEqual(count(3000), small);
  // 两次挑选（各一句 + 各自的关联三句 + 节点名一句）和一句总数。
  for (const n of Object.values(small)) assert(n <= 11, `查询 ${n} 句`);
});

test("摘要的查询计划：执行的每一句都不整表扫决定，按份走 decisions_active，挂节点的一路从 decision_nodes 索引进", () => {
  const db = seed(2000);
  const prepare = db.prepare.bind(db);
  const plan = (sql: string, args: (string | number)[] = []) =>
    (
      prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]
    ).map((r) => r.detail);
  let executed: string[] = [];
  db.prepare = ((sql: string) => {
    executed.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  for (const [label, scope] of scopes(db)) {
    executed = [];
    decisionDigest(db, scope);
    // 没绑参数时按 NULL 出计划；走哪个索引与参数值无关。
    const lines = executed.flatMap((sql) => plan(sql));
    const where = `${label}：\n${lines.join("\n")}`;
    assert(
      !lines.some((l) => /^SCAN (decisions|decision_nodes)\b/.test(l)),
      where,
    );
    if (scope.owners?.length)
      assert(
        lines.some((l) =>
          /USING (COVERING )?INDEX decisions_active \(owner=\?/.test(l),
        ),
        where,
      );
    if (scope.nodes?.length)
      assert(
        lines.some((l) => /INDEX decision_nodes_node \(node_id=\?\)/.test(l)),
        where,
      );
  }
  // 按份挑最近的直接按索引顺序取前 N 条，不为排序把这份全读出来。
  const one = pickSql({ owners: ["secretary"] }, 0, 15)!;
  const lines = plan(one.sql, one.args);
  assert(!lines.some((l) => l.includes("TEMP B-TREE")), lines.join("\n"));
  assert.equal(pickSql({}, 0, 15), null);
  assert.equal(totalSql({}).sql, "SELECT 0 AS n");
});
