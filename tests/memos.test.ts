import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { publishTask } from "../server/tasks/notice.ts";
import type { LeaderRunSpec } from "../server/leaders/runtime.ts";
import {
  dateOf,
  deciderOf,
  decisionLine,
  likePattern,
  nodeAddresses,
  recordOf,
  searchTerms,
  supersedeVerdict,
  validateDecision,
  type Decision,
} from "../server/memos/decisions.ts";
import {
  digestDecisions,
  nodeScope,
  omittedLine,
  ownerScope,
} from "../server/memos/digest.ts";
import {
  changeWhy,
  manageVerdict,
  settleVerdict,
  unsupersedeVerdict,
} from "../server/memos/curate.ts";
import { ensureMemoTables, memoText } from "../server/memos/store.ts";
import { leaderRule } from "../server/leaders/scope.ts";
import { until } from "./task-fixture.ts";
import { removeTemp } from "./temp-dir.ts";

/**
 * 秘书与 leader 的备忘和决定记录（t97）：纯函数判定穷举；集成走内存服务，
 * 覆盖追加、推翻、只列有效、分页、leader 令牌只能动自己的、唤醒提示词、网页接口与旧列迁移。
 */

// ---- 纯函数 ----

const NOW = new Date(2026, 8, 27, 12).getTime();

test("谁拍板：缺省是记录的主人；u1、secretary、秘书、aN 可用，其余报 --by", () => {
  assert.equal(deciderOf(undefined, "secretary"), "secretary");
  assert.equal(deciderOf("", "a1"), "a1");
  assert.equal(deciderOf("u1", "secretary"), "u1");
  assert.equal(deciderOf("秘书", "a1"), "secretary");
  assert.equal(deciderOf("secretary", "a1"), "secretary");
  assert.equal(deciderOf(" a12 ", "secretary"), "a12");
  for (const bad of ["u2", "a0", "老板", 3])
    assert.throws(() => deciderOf(bad, "secretary"), /--by: 谁拍板/);
});

test("日期：缺省本地今天；只认真实存在、不在将来的 YYYY-MM-DD", () => {
  assert.equal(dateOf(undefined, NOW), "2026-09-27");
  assert.equal(dateOf("2026-09-26", NOW), "2026-09-26");
  for (const bad of ["2026-9-26", "2026-02-30", "2026-13-01", "昨天", 20260926])
    assert.throws(() => dateOf(bad, NOW), /--date: 日期应为/);
  assert.throws(() => dateOf("2026-09-28", NOW), /不能是将来/);
});

test("决定字段校验：必填、上限、关联格式与未知字段，报命令行参数名", () => {
  const ok = validateDecision(
    {
      text: " 额度读取不依赖 OpenQuota ",
      why: "要迁到别的设备",
      by: "u1",
      issue: "#352",
      task: "t9",
      node: "o3",
      supersedes: "d2",
    },
    "secretary",
    NOW,
  );
  assert.deepEqual(ok, {
    text: "额度读取不依赖 OpenQuota",
    why: "要迁到别的设备",
    by: "u1",
    date: "2026-09-27",
    issue: 352,
    nodes: ["o3"],
    task: 9,
    supersedes: 2,
    principle: false,
  });
  assert.deepEqual(
    validateDecision(
      { text: "x", why: "y", node: ["o3", " o4 ", "o3"], principle: true },
      "a1",
      NOW,
    ).nodes,
    ["o3", "o4"],
  );
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ why: "x" }, /决定: 决定不能为空/],
    [{ text: "x" }, /--why: 原因不能为空/],
    [{ text: "x", why: "  " }, /--why: 原因不能为空/],
    [{ text: "字".repeat(301), why: "x" }, /决定: 决定不能超过 300 字/],
    [{ text: "x", why: "字".repeat(1001) }, /--why: 原因不能超过 1000 字/],
    [{ text: "x", why: "y", issue: "abc" }, /--issue: 应为 issue 号/],
    [{ text: "x", why: "y", task: "task9" }, /--task: 任务短号/],
    [{ text: "x", why: "y", supersedes: "k1" }, /--supersedes: 决定短号/],
    [{ text: "x", why: "y", node: 3 }, /--node: 应为组织节点/],
    [{ text: "x", why: "y", node: ["o1", ""] }, /--node: 应为组织节点/],
    [{ text: "x", why: "y", principle: "yes" }, /--principle: 应为开关/],
    [{ text: "x", why: "y", owner: "a1" }, /owner: 是未知字段/],
  ];
  for (const [body, message] of cases)
    assert.throws(() => validateDecision(body, "secretary", NOW), message);
  assert.throws(() => validateDecision([], "secretary"), /请求体应为对象/);
});

test("挂节点：一个或多个，去重去空白，至多 10 个", () => {
  assert.deepEqual(nodeAddresses(undefined), []);
  assert.deepEqual(nodeAddresses("o3"), ["o3"]);
  assert.deepEqual(nodeAddresses(["o3", "atrium/org", "o3"]), [
    "o3",
    "atrium/org",
  ]);
  assert.throws(
    () => nodeAddresses(Array.from({ length: 11 }, (_, i) => `o${i + 1}`)),
    /至多挂 10 个节点/,
  );
});

test("记进谁那份：用户拍板的进用户那份，其余进 --as 那份；用户那份不放别人定的", () => {
  assert.equal(recordOf("secretary", "u1"), "u1");
  assert.equal(recordOf("a1", "u1"), "u1");
  assert.equal(recordOf("u1", "u1"), "u1");
  assert.equal(recordOf("secretary", "secretary"), "secretary");
  assert.equal(recordOf("a1", "a1"), "a1");
  assert.equal(recordOf("a1", "secretary"), "a1");
  assert.throws(
    () => recordOf("u1", "secretary"),
    /用户的决定记录只放 u1 定的；秘书定的记进它自己那份（用 --as secretary）/,
  );
  assert.throws(() => recordOf("u1", "a2"), /--as a2/);
});

test("推翻判定：同一份记录、旧的有效、新的有效且不是同一条", () => {
  const d = (id: number, owner = "secretary", by: number | null = null) => ({
    id,
    owner,
    superseded_by: by,
  });
  assert.equal(supersedeVerdict("secretary", d(1), d(2)), null);
  assert.match(supersedeVerdict("secretary", d(1), d(1))!, /不能推翻自己/);
  assert.match(
    supersedeVerdict("secretary", d(1, "a1"), d(2))!,
    /d1 是 a1 的决定记录，不在 秘书 的记录里（用 --as a1）/,
  );
  assert.match(
    supersedeVerdict("a1", d(1, "a1"), d(2))!,
    /d2 是 秘书 的决定记录/,
  );
  assert.match(
    supersedeVerdict("secretary", d(1, "secretary", 3), d(2))!,
    /d1 已被 d3 推翻/,
  );
  // 秘书与用户的记录算一处；用户新定的可以推翻 leader 自己早先的，反过来不行。
  assert.equal(supersedeVerdict("secretary", d(1, "u1"), d(2)), null);
  assert.equal(supersedeVerdict("u1", d(1), d(2, "u1")), null);
  assert.equal(supersedeVerdict("a1", d(1, "a1"), d(2, "u1")), null);
  assert.match(
    supersedeVerdict("a1", d(1, "u1"), d(2, "a1"))!,
    /d1 是 用户 的决定记录，不在 a1 的记录里（用 --as u1）/,
  );
  assert.match(
    supersedeVerdict("secretary", d(1), d(2, "secretary", 4))!,
    /d2 自己已被 d4 推翻/,
  );
});

test("摘要选取：先原则、后最近的，最近的有条数上限，整段有字数上限，放不下的只计数", () => {
  const item = (name: string, size = 10) => ({ name, size });
  const size = (d: { size: number }) => d.size;
  const principles = [item("p1"), item("p2")];
  const recent = Array.from({ length: 20 }, (_, i) => item(`r${i}`));
  const all = digestDecisions(principles, recent, 30, size, {
    recent: 15,
    chars: 10_000,
  });
  assert.deepEqual(
    all.shown.map((d) => d.name),
    ["p1", "p2", ...recent.slice(0, 15).map((d) => d.name)],
  );
  assert.equal(all.omitted, 13);
  // 字数上限：按顺序放，超出就停（不跳着塞后面短的），原则也算在里面。
  const capped = digestDecisions(
    [item("p1", 40), item("p2", 40)],
    [item("r1", 30), item("r2", 5)],
    4,
    size,
    { recent: 15, chars: 100 },
  );
  assert.deepEqual(
    capped.shown.map((d) => d.name),
    ["p1", "p2"],
  );
  assert.equal(capped.omitted, 2);
  // 原则自己就超了：只放得下的部分。
  assert.deepEqual(
    digestDecisions([item("p1", 80), item("p2", 80)], [], 2, size, {
      recent: 15,
      chars: 100,
    }).shown.map((d) => d.name),
    ["p1"],
  );
  assert.deepEqual(digestDecisions([], [], 0, size), {
    shown: [],
    omitted: 0,
  });
  assert.equal(omittedLine(0), null);
  assert.equal(
    omittedLine(40),
    "另有 40 条，用 atrium decision ls --node 节点 / atrium decision search 关键词 查",
  );
});

test("节点范围：本节点及上级；down 再加全部下级；不在树里的忽略", () => {
  // o1 ─ o2 ─ o3 ─ o5
  //    └ o4
  const list = [
    { id: 1, parent_id: null },
    { id: 2, parent_id: 1 },
    { id: 3, parent_id: 2 },
    { id: 4, parent_id: 1 },
    { id: 5, parent_id: 3 },
  ];
  assert.deepEqual(nodeScope(list, [3]), [1, 2, 3]);
  assert.deepEqual(nodeScope(list, [2], true), [1, 2, 3, 5]);
  assert.deepEqual(nodeScope(list, [3, 4]), [1, 2, 3, 4]);
  assert.deepEqual(nodeScope(list, [9]), []);
  assert.deepEqual(nodeScope(list, []), []);
});

test("谁看哪些决定：用户看自己的；秘书看自己的与用户的；leader 看自己的加负责部分（含下级）及上级的", () => {
  const list = [
    { id: 1, parent_id: null, leader: null, archived_at: null },
    { id: 2, parent_id: 1, leader: "a1", archived_at: null },
    { id: 3, parent_id: 2, leader: null, archived_at: null },
    { id: 4, parent_id: 1, leader: "a2", archived_at: null },
    { id: 5, parent_id: 1, leader: "a1", archived_at: 9 },
  ];
  assert.deepEqual(ownerScope("u1", list), { owners: ["u1"] });
  assert.deepEqual(ownerScope("secretary", list), {
    owners: ["secretary", "u1"],
  });
  assert.deepEqual(ownerScope("a1", list), {
    owners: ["a1"],
    nodes: [1, 2, 3],
  });
  assert.deepEqual(ownerScope("a9", list), { owners: ["a9"], nodes: [] });
});

test("检索词：按空白拆、去重，至多 5 个、每个 50 字；LIKE 通配符转义", () => {
  assert.deepEqual(searchTerms("  额度  OpenQuota 额度 "), [
    "额度",
    "OpenQuota",
  ]);
  for (const bad of ["", "  ", 3, undefined])
    assert.throws(() => searchTerms(bad), /关键词: 不能为空/);
  assert.throws(() => searchTerms("a b c d e f"), /至多 5 个/);
  assert.throws(() => searchTerms("字".repeat(51)), /每个至多 50 字/);
  assert.equal(likePattern("50%_a\\b"), "%50\\%\\_a\\\\b%");
});

test("整理判定：leader 只能整理自己的；被推翻或已沉淀的不再沉淀；没被推翻的不用撤销；撤销要写原因", () => {
  assert.equal(manageVerdict(undefined, "u1", 1), null);
  assert.equal(manageVerdict("a1", "a1", 1), null);
  assert.equal(
    manageVerdict("a1", "secretary", 3),
    "d3 是 秘书 的决定记录，a1 只能整理自己的",
  );
  assert.equal(
    settleVerdict({ id: 1, superseded_by: null, settled_point: null }),
    null,
  );
  assert.match(
    settleVerdict({ id: 1, superseded_by: 4, settled_point: null })!,
    /d1 已被 d4 推翻/,
  );
  assert.match(
    settleVerdict({ id: 1, superseded_by: null, settled_point: 7 })!,
    /d1 已沉淀到 k7/,
  );
  assert.equal(unsupersedeVerdict({ id: 1, superseded_by: 4 }), null);
  assert.match(
    unsupersedeVerdict({ id: 1, superseded_by: null })!,
    /没被推翻，不用撤销/,
  );
  assert.equal(changeWhy("  标错了 "), "标错了");
  assert.throws(() => changeWhy(" "), /--why: 原因必填/);
  assert.throws(() => changeWhy("字".repeat(301)), /不能超过 300 字/);
});

test("决定一行：日期、谁定的、原因、关联、推翻关系", () => {
  const base: Decision = {
    ref: "d3",
    owner: "secretary",
    date: "2026-09-27",
    by: "u1",
    text: "秘书备忘进 Atrium",
    why: "换机器带不走",
    issue: 355,
    nodes: [
      { ref: "o3", name: "组织和规矩" },
      { ref: "o5", name: null },
    ],
    task: "t97",
    principle: false,
    settled_to: null,
    superseded_by: null,
    supersedes: ["d1"],
    restored: null,
    created_at: 0,
  };
  assert.equal(
    decisionLine(base),
    "d3 09-27 u1 定：秘书备忘进 Atrium——换机器带不走（#355 o3 o5 t97）（推翻 d1）",
  );
  assert.equal(
    decisionLine({
      ...base,
      by: "secretary",
      issue: null,
      nodes: [],
      task: null,
      supersedes: [],
      superseded_by: "d5",
    }),
    "d3 09-27 秘书 定：秘书备忘进 Atrium——换机器带不走【已被 d5 推翻】",
  );
  assert.equal(
    decisionLine({
      ...base,
      principle: true,
      issue: null,
      nodes: [],
      task: null,
      supersedes: [],
      settled_to: "k4",
    }),
    "d3 09-27 u1 定（原则）：秘书备忘进 Atrium——换机器带不走【已沉淀到 k4】",
  );
});

test("备忘正文：去首尾空白，超上限报错并给看现状的命令", () => {
  assert.equal(memoText("  在等 t5  "), "在等 t5");
  assert.throws(() => memoText(3), /memo: 应为文本/);
  assert.throws(
    () => memoText("字".repeat(2001), "atrium memo show"),
    /备忘 2001 字，超过上限 2000 字/,
  );
});

test("leader 权限表：备忘与决定记录的写接口按 ?as= 锁成自己放行", () => {
  assert.equal(leaderRule("PUT", "/api/memo"), "self");
  assert.equal(leaderRule("POST", "/api/decisions"), "self");
  assert.equal(leaderRule("POST", "/api/decisions/:id/supersede"), "self");
  for (const verb of ["tag", "mark", "settle", "unsupersede"])
    assert.equal(leaderRule("POST", `/api/decisions/:id/${verb}`), "self");
  assert.equal(leaderRule("GET", "/api/decisions"), "read");
  assert.equal(leaderRule("DELETE", "/api/decisions/:id"), "deny");
});

test("早先 org_leaders.memo 里的 leader 备忘启动时迁到 memos，已有的不覆盖；带旧运行时的表照常", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE org_leaders (id INTEGER PRIMARY KEY, name TEXT NOT NULL, worker TEXT NOT NULL,
      memo TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO org_leaders VALUES (1,'甲','codex','旧备忘',1,5),(2,'乙','codex','',1,1),(3,'丙','codex','旧的丙',1,1);`);
  db.exec(
    "CREATE TABLE memos (owner TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO memos VALUES ('a3','新的丙',9)",
  );
  ensureMemoTables(db);
  ensureMemoTables(db);
  assert.deepEqual(
    db
      .prepare("SELECT owner,body,updated_at FROM memos ORDER BY owner")
      .all()
      .map((r) => ({ ...r })),
    [
      { owner: "a1", body: "旧备忘", updated_at: 5 },
      { owner: "a3", body: "新的丙", updated_at: 9 },
    ],
  );
});

test("旧库迁移：秘书记录里 u1 定的迁到用户那份（短号不变），单节点列搬进挂节点表，补列；幂等、带旧运行时的表照常", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, decided_on TEXT NOT NULL,
      decided_by TEXT NOT NULL, text TEXT NOT NULL, why TEXT NOT NULL,
      issue INTEGER, node_id INTEGER, task_id INTEGER,
      superseded_by INTEGER, superseded_at INTEGER, created_at INTEGER NOT NULL);
    INSERT INTO decisions(id,owner,decided_on,decided_by,text,why,node_id,created_at) VALUES
      (3,'secretary','2026-09-26','u1','用户定的','甲',2,1),
      (5,'secretary','2026-09-26','secretary','秘书定的','乙',NULL,1),
      (7,'a1','2026-09-27','u1','leader 转记用户的','丙',4,1),
      (9,'a1','2026-09-27','a1','leader 定的','丁',NULL,1);`);
  ensureMemoTables(db);
  ensureMemoTables(db);
  const rows = db
    .prepare(
      "SELECT id,owner,principle,settled_point FROM decisions ORDER BY id",
    )
    .all()
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { id: 3, owner: "u1", principle: 0, settled_point: null },
    { id: 5, owner: "secretary", principle: 0, settled_point: null },
    { id: 7, owner: "a1", principle: 0, settled_point: null },
    { id: 9, owner: "a1", principle: 0, settled_point: null },
  ]);
  assert.deepEqual(
    db
      .prepare(
        "SELECT decision_id,node_id FROM decision_nodes ORDER BY decision_id",
      )
      .all()
      .map((r) => ({ ...r })),
    [
      { decision_id: 3, node_id: 2 },
      { decision_id: 7, node_id: 4 },
    ],
  );
});

// ---- 集成 ----

async function open(t: { after: (fn: () => unknown) => void }) {
  const data = mkdtempSync(join(tmpdir(), "atrium-memos-"));
  t.after(() => removeTemp(data));
  const runs: LeaderRunSpec[] = [];
  let behave: (spec: LeaderRunSpec) => Promise<"ok"> = async () => "ok";
  const created = await createApp({
    data,
    auth: true,
    controlToken: "c".repeat(64),
    tasks: { pace: async () => undefined },
    leaders: {
      batchMs: 0,
      pollMs: 20,
      run: async (spec) => {
        runs.push(spec);
        return behave(spec);
      },
    },
  });
  t.after(() => created.app.close());
  const user = `Bearer ${readFileSync(userTokenPath(data), "utf8").trim()}`;
  const call = async (
    method: "GET" | "POST" | "PATCH" | "PUT",
    url: string,
    payload?: unknown,
    authorization = user,
  ) => {
    const response = await created.app.inject({
      method,
      url,
      headers: { host: "127.0.0.1", authorization },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return {
      status: response.statusCode,
      body: response.body ? (response.json() as Record<string, any>) : {},
    };
  };
  const ok = async (...args: Parameters<typeof call>) => {
    const result = await call(...args);
    assert(
      result.status < 300,
      `${args[0]} ${args[1]} → ${result.status} ${JSON.stringify(result.body)}`,
    );
    return result.body;
  };
  await ok("POST", "/api/org/nodes", {
    slug: "org",
    kind: "org",
    name: "组织",
    reason: "建",
  });
  await ok("POST", "/api/org/nodes", {
    parent: "o1",
    slug: "atrium",
    kind: "project",
    name: "Atrium",
    reason: "建",
  });
  return {
    ...created,
    runs,
    call,
    ok,
    set: (next: typeof behave) => {
      behave = next;
    },
  };
}

test("决定记录：追加三条、推翻一条，缺省只列有效的，--all 全列；分页与破坏输入", async (t) => {
  const x = await open(t);
  const d1 = await x.ok("POST", "/api/decisions", {
    text: "秘书的决定记录作为私人备忘",
    why: "先不做",
    date: "2026-09-26",
  });
  assert.equal(d1.ref, "d1");
  assert.equal(d1.owner, "secretary");
  const d2 = await x.ok("POST", "/api/decisions?as=secretary", {
    text: "额度读取不依赖 OpenQuota",
    why: "要迁到别的设备",
    by: "secretary",
    issue: "352",
    node: "atrium",
  });
  assert.deepEqual(d2.nodes, [{ ref: "o2", name: "Atrium" }]);
  assert.equal(d2.issue, 352);
  const d3 = await x.ok("POST", "/api/decisions", {
    text: "秘书和 leader 的备忘进 Atrium",
    why: "换机器、换秘书带不走",
    issue: 355,
  });
  const superseded = await x.ok("POST", "/api/decisions/d1/supersede", {
    by: "d3",
  });
  assert.equal(superseded.old.superseded_by, "d3");
  assert.deepEqual(superseded.next.supersedes, ["d1"]);

  const active = await x.ok("GET", "/api/decisions");
  assert.deepEqual(
    active.decisions.map((d: Decision) => d.ref),
    [d3.ref, d2.ref],
  );
  assert.equal(active.active, 2);
  assert.equal(active.superseded, 1);
  const everything = await x.ok("GET", "/api/decisions?all=1");
  assert.deepEqual(
    everything.decisions.map((d: Decision) => d.ref),
    ["d3", "d2", "d1"],
  );
  // 分页：按 (日期, 编号) 倒序接着取。
  const first = await x.ok("GET", "/api/decisions?all=1&limit=2");
  assert.equal(first.next_before, "d2");
  const second = await x.ok("GET", "/api/decisions?all=1&limit=2&before=d2");
  assert.deepEqual(
    second.decisions.map((d: Decision) => d.ref),
    ["d1"],
  );
  assert.equal(second.next_before, null);

  // 破坏输入：逐条报错，不落库。
  const bad: [string, string, unknown, number, RegExp][] = [
    ["POST", "/api/decisions", { text: "x" }, 400, /--why: 原因不能为空/],
    [
      "POST",
      "/api/decisions",
      { text: "x", why: "y", task: "t99" },
      404,
      /--task: 任务 t99 不存在/,
    ],
    [
      "POST",
      "/api/decisions",
      { text: "x", why: "y", supersedes: "d1" },
      409,
      /d1 已被 d3 推翻/,
    ],
    ["POST", "/api/decisions/d2/supersede", { by: "d2" }, 409, /不能推翻自己/],
    [
      "POST",
      "/api/decisions/d2/supersede",
      { by: "d1" },
      409,
      /d1 自己已被 d3 推翻/,
    ],
    ["POST", "/api/decisions/d9/supersede", { by: "d2" }, 404, /d9 不存在/],
    ["POST", "/api/decisions/x1/supersede", { by: "d2" }, 400, /决定短号/],
    [
      "POST",
      "/api/decisions?as=a7",
      { text: "x", why: "y" },
      404,
      /a7 没有登记/,
    ],
    ["POST", "/api/decisions?as=u2", { text: "x", why: "y" }, 400, /--as/],
    [
      "POST",
      "/api/decisions?as=u1",
      { text: "x", why: "y", by: "secretary" },
      400,
      /用户的决定记录只放 u1 定的/,
    ],
    ["POST", "/api/decisions", { text: "x", why: "y", node: "o9" }, 404, /o9/],
    ["GET", "/api/decisions?limit=500", undefined, 400, /--limit/],
  ];
  for (const [method, url, body, status, message] of bad) {
    const result = await x.call(method as "POST", url, body);
    assert.equal(result.status, status, `${url} ${JSON.stringify(body)}`);
    assert.match(result.body.error, message);
  }
  const after = await x.ok("GET", "/api/decisions?all=1");
  assert.equal(after.decisions.length, 3);
});

test("备忘：秘书 memo edit 后 memo show 可见；leader edit --memo 与 memo --as aN 同一份", async (t) => {
  const x = await open(t);
  const empty = await x.ok("GET", "/api/memo");
  assert.equal(empty.owner, "secretary");
  assert.equal(empty.memo, "");
  await x.ok("PUT", "/api/memo", { memo: "  在等 t97 上线，先看合入队列  " });
  await x.ok("POST", "/api/decisions", { text: "甲", why: "乙", by: "u1" });
  const shown = await x.ok("GET", "/api/memo?as=secretary");
  assert.equal(shown.memo, "在等 t97 上线，先看合入队列");
  assert.equal(shown.name, "秘书");
  assert.deepEqual(
    shown.decisions.map((d: Decision) => d.text),
    ["甲"],
  );
  const tooLong = await x.call("PUT", "/api/memo", { memo: "字".repeat(2001) });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /超过上限 2000 字/);
  assert.equal(
    (await x.call("PUT", "/api/memo", { memo: "x", extra: 1 })).status,
    400,
  );

  await x.ok("POST", "/api/leaders", {
    name: "Atrium 负责人",
    worker: "claude+opus",
    memo: "登记时写的",
  });
  assert.equal((await x.ok("GET", "/api/memo?as=a1")).memo, "登记时写的");
  await x.ok("PATCH", "/api/leaders/a1", { memo: "leader edit 写的" });
  assert.equal((await x.ok("GET", "/api/memo?as=a1")).memo, "leader edit 写的");
  await x.ok("PUT", "/api/memo?as=a1", { memo: "memo edit 写的" });
  assert.equal((await x.ok("GET", "/api/leaders/a1")).memo, "memo edit 写的");
  assert.equal(
    (await x.ok("GET", "/api/leaders")).leaders[0].memo,
    "memo edit 写的",
  );
  // 秘书的备忘没被动。
  assert.equal(
    (await x.ok("GET", "/api/memo")).memo,
    "在等 t97 上线，先看合入队列",
  );

  // 网页详情页：秘书页与负责人页只给摘要（已推翻的不列，全部走 /api/map/decisions）；没登记的 404。
  const old = await x.ok("POST", "/api/decisions?as=a1", {
    text: "旧做法",
    why: "当时够用",
  });
  await x.ok("POST", "/api/decisions?as=a1", {
    text: "新做法",
    why: "旧的不够",
    supersedes: old.ref,
  });
  const page = await x.ok("GET", "/api/map/leaders/a1");
  assert.equal(page.kind, "leader");
  assert.equal(page.memo, "memo edit 写的");
  assert.equal(typeof page.memo_updated_at, "number");
  assert.deepEqual(
    page.decisions.map((d: { text: string }) => d.text),
    ["新做法"],
  );
  assert.equal(page.total, 1);
  assert.deepEqual(
    (await x.ok("GET", "/api/map/decisions?of=a1&all=1")).decisions
      .map((d: { text: string }) => d.text)
      .sort(),
    ["新做法", "旧做法"].sort(),
  );
  assert.ok(Array.isArray(page.events));
  const secretary = await x.ok("GET", "/api/map/leaders/secretary");
  assert.equal(secretary.kind, "secretary");
  assert.equal(secretary.memo, "在等 t97 上线，先看合入队列");
  // 秘书页的摘要含用户的决定（「甲」是 u1 定的，记在用户那份）；用户页只有用户的。
  assert.deepEqual(
    secretary.decisions.map((d: { owner: string; text: string }) => [
      d.owner,
      d.text,
    ]),
    [["u1", "甲"]],
  );
  const user = await x.ok("GET", "/api/map/leaders/u1");
  assert.equal(user.kind, "user");
  assert.deepEqual(
    user.decisions.map((d: { text: string }) => d.text),
    ["甲"],
  );
  assert.equal((await x.call("GET", "/api/map/leaders/a9")).status, 404);
  assert.equal((await x.call("GET", "/api/map/decisions?of=a9")).status, 404);
});

test("leader 唤醒提示词带自己的备忘与最近的有效决定；令牌只能读写自己的记录", async (t) => {
  const x = await open(t);
  await x.ok("POST", "/api/leaders", { name: "负责人", worker: "codex" });
  await x.ok("PATCH", "/api/org/nodes/o2", { leader: "a1", reason: "指派" });
  await x.ok("PUT", "/api/memo?as=a1", { memo: "上次在等 t1 的 CI" });
  await x.ok("POST", "/api/decisions?as=a1", {
    text: "旧取舍",
    why: "当时这么想",
  });
  await x.ok("POST", "/api/decisions?as=a1", {
    text: "t1 改派 codex",
    why: "claude 连续超时",
    supersedes: "d1",
  });
  await x.ok("POST", "/api/decisions", {
    text: "秘书的决定",
    why: "不给 a1 看",
  });
  await x.ok("POST", "/api/tasks", {
    title: "待处理",
    part: "o2",
    deliver: "none",
  });
  let checked = false;
  let failure: unknown;
  x.set(async (spec) => {
    if (checked || failure) return "ok";
    try {
      assert.match(spec.prompt, /上次在等 t1 的 CI/);
      assert.match(
        spec.prompt,
        /d2 \d\d-\d\d a1 定：t1 改派 codex——claude 连续超时（推翻 d1）/,
      );
      assert.doesNotMatch(spec.prompt, /旧取舍/);
      assert.doesNotMatch(spec.prompt, /秘书的决定/);
      assert.match(spec.prompt, /atrium decision add 决定 --why 原因/);
      const token = `Bearer ${spec.env.ATRIUM_LEADER_TOKEN}`;
      const own = await x.call(
        "PUT",
        "/api/memo",
        { memo: "这次处理完了" },
        token,
      );
      assert.equal(own.status, 200, JSON.stringify(own.body));
      assert.equal(own.body.owner, "a1");
      const added = await x.call(
        "POST",
        "/api/decisions",
        { text: "不重派", why: "等依赖" },
        token,
      );
      assert.equal(added.status, 201, JSON.stringify(added.body));
      assert.equal(added.body.owner, "a1");
      assert.equal(
        (await x.call("GET", "/api/memo", undefined, token)).body.memo,
        "这次处理完了",
      );
      // 不能读写秘书的：?as= 锁成自己。
      for (const [method, url, body] of [
        ["GET", "/api/memo?as=secretary", undefined],
        ["PUT", "/api/memo?as=secretary", { memo: "改秘书的" }],
        ["POST", "/api/decisions?as=secretary", { text: "x", why: "y" }],
        ["POST", "/api/decisions/d3/supersede?as=secretary", { by: "d2" }],
      ] as const) {
        const denied = await x.call(method, url, body, token);
        assert.equal(denied.status, 403, `${method} ${url}`);
        assert.match(denied.body.error, /只能用自己（a1）/);
      }
      // 秘书的决定不在 a1 的记录里。
      const cross = await x.call(
        "POST",
        "/api/decisions/d3/supersede",
        { by: "d2" },
        token,
      );
      assert.equal(cross.status, 409);
      assert.match(cross.body.error, /d3 是 秘书 的决定记录/);
      checked = true;
    } catch (error) {
      failure = error;
    }
    return "ok";
  });
  publishTask(x.taskRunner.inbox, x.db, 1, "failed", { reason: "测试没过" });
  await until(() => checked || failure !== undefined, 20000);
  if (failure) throw failure;
  assert.equal((await x.ok("GET", "/api/memo")).memo, "");
  assert.equal((await x.ok("GET", "/api/memo?as=a1")).memo, "这次处理完了");
});

test("用户那份、挂节点、按节点列、检索、原则与摘要上限", async (t) => {
  const x = await open(t);
  await x.ok("POST", "/api/org/nodes", {
    parent: "o2",
    slug: "cli",
    kind: "module",
    name: "命令行",
    reason: "建",
  });
  await x.ok("POST", "/api/org/nodes", {
    parent: "o1",
    slug: "oq",
    kind: "project",
    name: "OpenQuota",
    reason: "建",
  });
  await x.ok("POST", "/api/leaders", { name: "命令行负责人", worker: "codex" });
  await x.ok("PATCH", "/api/org/nodes/o3", { leader: "a1", reason: "指派" });

  // --by u1 缺省进用户那份；秘书自己的留在秘书那份；--node 可多次。
  const user = await x.ok("POST", "/api/decisions", {
    text: "汇报要短",
    why: "你是决策者",
    by: "u1",
    node: ["o1", "o2"],
    principle: true,
  });
  assert.equal(user.owner, "u1");
  assert.equal(user.principle, true);
  assert.deepEqual(
    user.nodes.map((n: { ref: string }) => n.ref),
    ["o1", "o2"],
  );
  const mine = await x.ok("POST", "/api/decisions", {
    text: "OpenQuota 先不拆仓库",
    why: "用的人少",
    node: "o4",
  });
  assert.equal(mine.owner, "secretary");
  // leader 转记用户拍板的：进用户那份，没给节点就挂它负责的部分。
  const relayed = await x.ok("POST", "/api/decisions?as=a1", {
    text: "命令行错误信息用中文",
    why: "用户看得懂",
    by: "u1",
  });
  assert.equal(relayed.owner, "u1");
  assert.deepEqual(
    relayed.nodes.map((n: { ref: string }) => n.ref),
    ["o3"],
  );

  // 按节点列：本节点及上级的，谁记的都算；别的分支不列。
  const underCli = await x.ok("GET", "/api/decisions?node=o3");
  assert.equal(underCli.node, "o3");
  assert.deepEqual(
    underCli.decisions.map((d: Decision) => d.ref).sort(),
    [user.ref, relayed.ref].sort(),
  );
  assert.deepEqual(
    (await x.ok("GET", "/api/decisions?node=oq")).decisions.map(
      (d: Decision) => d.ref,
    ),
    [mine.ref, user.ref],
  );
  // 各自那份：秘书的只有秘书的，用户的只有用户的。
  assert.deepEqual(
    (await x.ok("GET", "/api/decisions")).decisions.map((d: Decision) => d.ref),
    [mine.ref],
  );
  assert.equal((await x.ok("GET", "/api/decisions?as=u1")).active, 2);

  // 补挂节点：已挂的不重复，节点不存在报错不落库。
  const tagged = await x.ok("POST", `/api/decisions/${mine.ref}/tag`, {
    node: ["o4", "o2"],
  });
  assert.deepEqual(
    tagged.nodes.map((n: { ref: string }) => n.ref),
    ["o2", "o4"],
  );
  const badTag = await x.call("POST", `/api/decisions/${mine.ref}/tag`, {
    node: ["o9"],
  });
  assert.equal(badTag.status, 404);
  assert.equal(
    (await x.call("POST", "/api/decisions/d99/tag", { node: "o2" })).status,
    404,
  );
  assert.equal(
    (await x.call("POST", `/api/decisions/${mine.ref}/tag`, {})).status,
    400,
  );

  // 检索：决定与原因里都算，几个词须全部命中；参数化，通配符不起作用。
  const found = await x.ok(
    "GET",
    `/api/decisions/search?q=${encodeURIComponent("中文 用户")}`,
  );
  assert.deepEqual(
    found.decisions.map((d: Decision) => d.ref),
    [relayed.ref],
  );
  assert.equal(
    (await x.ok("GET", `/api/decisions/search?q=${encodeURIComponent("%")}`))
      .decisions.length,
    0,
  );
  assert.equal(
    (
      await x.ok(
        "GET",
        `/api/decisions/search?q=${encodeURIComponent("汇报")}&owner=secretary`,
      )
    ).decisions.length,
    0,
  );
  assert.equal((await x.call("GET", "/api/decisions/search?q=")).status, 400);

  // 摘要：原则全列、再加最近 15 条；多的只计数。
  for (let i = 0; i < 20; i++)
    await x.ok("POST", "/api/decisions", {
      text: `第 ${i} 条`,
      why: "例行",
      date: "2026-09-20",
    });
  const digest = await x.ok("GET", "/api/memo");
  assert.equal(digest.decisions[0].ref, user.ref);
  assert.equal(digest.principles, 1);
  assert.equal(digest.decisions.length, 16);
  assert.equal(digest.total, 23);
  assert.equal(digest.omitted, 7);
  // 标原则后总在摘要里；取消后回到按时间。
  const old = await x.ok("GET", "/api/decisions?limit=200");
  const oldest = old.decisions[old.decisions.length - 1];
  await x.ok("POST", `/api/decisions/${oldest.ref}/mark`, { principle: true });
  assert.ok(
    (await x.ok("GET", "/api/memo")).decisions.some(
      (d: Decision) => d.ref === oldest.ref && d.principle,
    ),
  );
  await x.ok("POST", `/api/decisions/${oldest.ref}/mark`, { principle: false });
  assert.ok(
    !(await x.ok("GET", "/api/memo")).decisions.some(
      (d: Decision) => d.ref === oldest.ref,
    ),
  );
  assert.equal(
    (await x.call("POST", `/api/decisions/${oldest.ref}/mark`, {})).status,
    400,
  );
  // 字数上限：长的决定塞不下时只给计数。
  for (let i = 0; i < 12; i++)
    await x.ok("POST", "/api/decisions", {
      text: `长决定 ${i} ${"字".repeat(250)}`,
      why: "原因".repeat(100),
    });
  const capped = await x.ok("GET", "/api/memo");
  const size = capped.decisions.reduce(
    (n: number, d: Decision) => n + Array.from(decisionLine(d)).length + 3,
    0,
  );
  assert.ok(size <= 3000, `摘要 ${size} 字`);
  assert.ok(capped.decisions.length < 16);
  assert.equal(capped.omitted, capped.total - capped.decisions.length);

  // leader 的摘要：自己的，加挂在负责部分及上级的（用户挂在 o1/o2 的原则也在），别的分支的不在。
  const lead = await x.ok("GET", "/api/memo?as=a1");
  const refs = lead.decisions.map((d: Decision) => d.ref);
  assert.ok(refs.includes(user.ref));
  assert.ok(refs.includes(relayed.ref));
  assert.ok(refs.includes(mine.ref), "mine 已补挂 o2");
  assert.ok(!lead.decisions.some((d: Decision) => d.text.startsWith("第")));
  assert.ok(
    lead.decisions.every(
      (d: Decision) => d.owner === "a1" || d.nodes.length > 0,
    ),
  );

  // 块页的决定：挂在本块及上级的摘要；全景展开与检索。
  const node = await x.ok("GET", "/api/map/nodes/o3");
  assert.deepEqual(
    node.decisions.decisions.map((d: Decision) => d.ref).sort(),
    [user.ref, relayed.ref, mine.ref].sort(),
  );
  const searched = await x.ok(
    "GET",
    `/api/map/decisions?of=o3&q=${encodeURIComponent("中文")}`,
  );
  assert.deepEqual(
    searched.decisions.map((d: Decision) => d.ref),
    [relayed.ref],
  );
  assert.equal(
    (await x.ok("GET", "/api/map/decisions?of=u1&all=1")).decisions.length,
    2,
  );
});

test("沉淀成要点、撤销误标的推翻；leader 令牌只能整理自己那份", async (t) => {
  const x = await open(t);
  await x.ok("POST", "/api/leaders", { name: "负责人", worker: "codex" });
  await x.ok("PATCH", "/api/org/nodes/o2", { leader: "a1", reason: "指派" });
  const d1 = await x.ok("POST", "/api/decisions", {
    text: "测试不依赖本机真实环境",
    why: "两次因为这个误判",
    node: "o2",
  });
  const d2 = await x.ok("POST", "/api/decisions", {
    text: "测试用临时目录",
    why: "同上",
  });
  // 新建要点：为什么缺省用决定的原因，谁定的缺省拍板人与日期；要点记来源。
  const settled = await x.ok("POST", `/api/decisions/${d1.ref}/settle`, {
    new_point: { node: "o2", text: "测试不依赖本机真实环境" },
  });
  assert.equal(settled.decision.settled_to, settled.point);
  const org = await x.ok("GET", "/api/map/nodes/o2");
  const point = org.points.find(
    (p: { ref: string }) => p.ref === settled.point,
  );
  assert.equal(point.why, "两次因为这个误判");
  assert.match(point.by, /^秘书 \d\d-\d\d 定$/);
  assert.deepEqual(point.sources, [d1.ref]);
  // 沉淀到已有要点：来源追加；已沉淀的不再沉淀。
  await x.ok("POST", `/api/decisions/${d2.ref}/settle`, {
    point: settled.point,
  });
  const again = await x.ok("GET", "/api/map/nodes/o2");
  assert.deepEqual(
    again.points.find((p: { ref: string }) => p.ref === settled.point).sources,
    [d1.ref, d2.ref],
  );
  const twice = await x.call("POST", `/api/decisions/${d1.ref}/settle`, {
    point: settled.point,
  });
  assert.equal(twice.status, 409);
  assert.match(twice.body.error, /已沉淀到 k/);
  for (const body of [
    {},
    { point: "k1", new_point: { node: "o2", text: "x" } },
  ])
    assert.equal(
      (await x.call("POST", `/api/decisions/${d2.ref}/settle`, body)).status,
      400,
    );
  // 已沉淀的缺省不列、摘要不给；--all 列出来。
  assert.equal((await x.ok("GET", "/api/decisions")).decisions.length, 0);
  assert.equal((await x.ok("GET", "/api/decisions")).settled, 2);
  assert.equal((await x.ok("GET", "/api/memo")).total, 0);
  assert.equal((await x.ok("GET", "/api/decisions?all=1")).decisions.length, 2);

  // 撤销误标的推翻：恢复为有效，记谁、为什么、原先被哪条推翻。
  const d3 = await x.ok("POST", "/api/decisions", { text: "甲", why: "乙" });
  const d4 = await x.ok("POST", "/api/decisions", {
    text: "丙",
    why: "丁",
    supersedes: d3.ref,
  });
  const restored = await x.ok("POST", `/api/decisions/${d3.ref}/unsupersede`, {
    why: "标错了，说的是两件事",
  });
  assert.equal(restored.superseded_by, null);
  assert.deepEqual(
    restored.restored && {
      by: restored.restored.by,
      why: restored.restored.why,
      from: restored.restored.from,
    },
    { by: "secretary", why: "标错了，说的是两件事", from: d4.ref },
  );
  assert.deepEqual(
    (await x.ok("GET", "/api/decisions")).decisions
      .map((d: Decision) => d.ref)
      .sort(),
    [d3.ref, d4.ref].sort(),
  );
  const notSuperseded = await x.call(
    "POST",
    `/api/decisions/${d3.ref}/unsupersede`,
    { why: "再来" },
  );
  assert.equal(notSuperseded.status, 409);
  assert.equal(
    (await x.call("POST", `/api/decisions/${d4.ref}/unsupersede`, {})).status,
    400,
  );

  // leader 令牌：自己的能整理，秘书的不行。
  const own = await x.ok("POST", "/api/decisions?as=a1", {
    text: "负责人的取舍",
    why: "为什么",
  });
  await x.ok("POST", "/api/tasks", {
    title: "待处理",
    part: "o2",
    deliver: "none",
  });
  let checked = false;
  let failure: unknown;
  x.set(async (spec) => {
    if (checked || failure) return "ok";
    try {
      const token = `Bearer ${spec.env.ATRIUM_LEADER_TOKEN}`;
      assert.match(spec.prompt, /顺带看本部分的决定/);
      const tag = await x.call(
        "POST",
        `/api/decisions/${own.ref}/tag`,
        { node: "o2" },
        token,
      );
      assert.equal(tag.status, 200, JSON.stringify(tag.body));
      const mark = await x.call(
        "POST",
        `/api/decisions/${own.ref}/mark`,
        { principle: true },
        token,
      );
      assert.equal(mark.status, 200, JSON.stringify(mark.body));
      for (const [verb, body] of [
        ["tag", { node: "o2" }],
        ["mark", { principle: true }],
        ["unsupersede", { why: "x" }],
        ["settle", { point: "k1" }],
      ] as const) {
        const denied = await x.call(
          "POST",
          `/api/decisions/${d3.ref}/${verb}`,
          body,
          token,
        );
        assert.equal(denied.status, 403, verb);
        assert.match(denied.body.error, /a1 只能整理自己的/);
      }
      // 沉淀自己的到根节点：根的要点只有用户能改。
      const root = await x.call(
        "POST",
        `/api/decisions/${own.ref}/settle`,
        { new_point: { node: "o1", text: "x" } },
        token,
      );
      assert.equal(root.status, 403, JSON.stringify(root.body));
      checked = true;
    } catch (error) {
      failure = error;
    }
    return "ok";
  });
  publishTask(x.taskRunner.inbox, x.db, 1, "failed", { reason: "测试没过" });
  await until(() => checked || failure !== undefined, 20000);
  if (failure) throw failure;
  assert.equal(
    (await x.ok("GET", "/api/decisions?as=a1")).decisions[0].principle,
    true,
  );
});
