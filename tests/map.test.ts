import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { authPolicy } from "../server/auth-policy.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode, revertDoc } from "../server/org/write.ts";
import { history } from "../server/org/read.ts";
import { addPoint } from "../server/org/points.ts";
import { withContext } from "../server/org/brief.ts";
import {
  CONTEXT_MAX,
  formatContext,
  mapContext,
  taskContext,
  type ContextInput,
} from "../server/map/context.ts";
import { MapLogin, LINK_TTL_MS, cookieOf } from "../server/map/login.ts";
import { addMap, editMap, mergeFields } from "../server/map/write.ts";
import { mapNode, mapTree, mapSignature } from "../server/map/view.ts";
import { renderMapTree } from "../cli/map.ts";
import { createTask, ensureTaskTables } from "../server/tasks/ledger.ts";

const chars = (text: string) => Array.from(text).length;
const node = (db: DatabaseSync, input: Record<string, unknown>) =>
  addNode(db, { reason: "创建", ...input } as never, "u1");

/** o1 组织；o2 Atrium（a1）下 o3 runtime（a2）、o4 cli、o5 安全（关注点）；o6 OpenQuota。 */
function seed(db: DatabaseSync) {
  node(db, { slug: "org", kind: "org", name: "组织" });
  node(db, {
    parent: "o1",
    slug: "atrium",
    kind: "project",
    name: "Atrium",
    leader: "a1",
  });
  node(db, {
    parent: "o2",
    slug: "runtime",
    kind: "module",
    name: "runtime",
    leader: "a2",
  });
  node(db, { parent: "o2", slug: "cli", kind: "module", name: "cli" });
  node(db, { parent: "o2", slug: "安全", kind: "concern", name: "安全" });
  node(db, { parent: "o1", slug: "openquota", kind: "project", name: "OQ" });
}
function memory() {
  const db = new DatabaseSync(":memory:");
  ensureOrgTables(db);
  ensureTaskTables(db);
  seed(db);
  return db;
}
const point = (db: DatabaseSync, at: string, text: string, check?: string) =>
  addPoint(
    db,
    at,
    { text, why: `${text}的理由`, by: "u1 09-27", ...(check ? { check } : {}) },
    "u1",
  );

// ---- context：纯函数截断 ----

const level = (ref: string, name: string, what: string) => ({
  ref,
  name,
  alias: "",
  analogy: "",
  what,
});
function sample(): ContextInput {
  return {
    chain: [
      level("o1", "组织", "你的 AI 组织".repeat(20)),
      level("o2", "Atrium", "AI 组织的运行底座".repeat(10)),
      { ...level("o4", "cli", "命令行入口"), alias: "命令行", analogy: "前台" },
    ],
    parts: [{ name: "map", alias: "全景", analogy: "地图" }],
    now: "网页开发中",
    next: "接看板",
    points: [
      {
        name: "Atrium",
        points: [
          { text: "随时升级", why: "不等空闲", by: "u1 09-27", check: null },
        ],
      },
      {
        name: "cli",
        points: [
          {
            text: "网页只读",
            why: "两处改会冲突",
            by: "u1 09-27",
            check: "$ npm run check",
          },
        ],
      },
    ],
  };
}

test("map context：够长时全给，位置链、本块、要点（本节点与上级）都在，不给全文提示", () => {
  const { text, truncated } = formatContext(sample(), "o4", 8000);
  assert.equal(truncated, false);
  const lines = text.split("\n");
  assert.equal(lines[0], "全景位置：组织 → Atrium → 命令行（cli）（前台）");
  assert.match(text, /- 命令行（cli）：命令行入口/);
  assert.match(text, /本块由这几部分组成：全景（map）——地图/);
  assert.match(text, /现在：网页开发中\n接下来：接看板/);
  assert.match(
    text,
    /要点（本节点及上级，必须守住）：\n- \[Atrium\] 随时升级（为什么：不等空闲；u1 09-27 定）\n- \[cli\] 网页只读（为什么：两处改会冲突；u1 09-27 定；检查：\$ npm run check）/,
  );
  assert.doesNotMatch(text, /全文/);
});

test("map context：任何上限下都不超长；先丢远的上层，要点与本块优先保留，截了就给全文命令", () => {
  const full = formatContext(sample(), "o4", 8000).text;
  for (let max = 200; max <= chars(full) + 20; max += 7) {
    const { text, truncated } = formatContext(sample(), "o4", max);
    assert.ok(chars(text) <= max, `max=${max} 实得 ${chars(text)}`);
    assert.match(text, /^全景位置：/);
    assert.equal(truncated, text.endsWith("（全文：atrium map context o4）"));
    // 本块是什么与本块要点比上层介绍先留下。
    if (text.includes("你的 AI 组织")) {
      assert.match(text, /命令行入口/, `max=${max}`);
      assert.match(text, /网页只读/, `max=${max}`);
      assert.match(text, /随时升级/, `max=${max}`);
    }
    if (text.includes("随时升级")) assert.match(text, /网页只读/);
  }
  const tight = formatContext(sample(), "o4", 260).text;
  assert.match(tight, /命令行入口/);
  assert.match(tight, /网页只读/);
  assert.doesNotMatch(tight, /你的 AI 组织/);
  // 极端长的一条被截到单条上限，不挤掉其余。
  const long = sample();
  long.points[1]!.points[0]!.text = "很长".repeat(400);
  const cut = formatContext(long, "o4", 8000);
  assert.equal(cut.truncated, true);
  assert.match(cut.text, /随时升级/);
});

test("map context：读库时附本节点及上级的要点；派活提示词里与章程要点同一段", () => {
  const db = memory();
  editMap(db, "o2", { what: "AI 组织的运行底座", alias: "底座" }, "u1");
  editMap(db, "o4", { what: "命令行入口", analogy: "前台" }, "u1");
  point(db, "o2", "随时升级");
  point(db, "o4", "网页只读");
  point(db, "o6", "别处的要点");
  const context = mapContext(db, "atrium/cli");
  assert.equal(context.ref, "o4");
  assert.equal(context.max, CONTEXT_MAX);
  assert.match(context.text, /全景位置：组织 → 底座（Atrium） → cli（前台）/);
  assert.match(context.text, /\[Atrium\] 随时升级[\s\S]*\[cli\] 网页只读/);
  assert.doesNotMatch(context.text, /别处的要点/);
  assert.equal(taskContext(db, 4), context.text);
  assert.equal(taskContext(db, null), undefined);
  assert.equal(taskContext(db, 99), undefined);
  const merged = withContext(
    { heading: "章程要点（组织 → Atrium → cli）", text: "硬边界：无" },
    context.text,
  )!;
  assert.equal(merged.heading, "章程要点（组织 → Atrium → cli）");
  assert.ok(merged.text.startsWith("全景位置："));
  assert.ok(merged.text.endsWith("硬边界：无"));
  assert.equal(withContext(undefined, "x")!.heading, "全景位置与要点");
  assert.equal(withContext(undefined, undefined), undefined);
});

// ---- 读视图 ----

test("全景树与节点：按归属部分汇总任务，专员单列，要点与上级要点分开", () => {
  const db = memory();
  editMap(db, "o3", { alias: "派活员", analogy: "项目经理" }, "u1");
  point(db, "o2", "随时升级", "tests/upgrade.test.ts 接管");
  point(db, "o3", "不采信自述");
  const running = createTask(db, { title: "修派活", part: "o3" });
  db.prepare(
    "UPDATE tasks SET status='running',worker='claude+opus',started_at=1,pr_url='https://github.com/x/y/pull/9',repo='/r',issue=5 WHERE id=?",
  ).run(Number(running.ref.slice(1)));
  createTask(db, { title: "待办", part: "o4" });
  const { tree } = mapTree(db, undefined, 1);
  assert.equal(tree!.ref, "o1");
  assert.deepEqual(tree!.tasks, { running: 1, blocked: 0, open: 2 });
  assert.equal(tree!.dot, "running");
  assert.equal(tree!.children![0]!.children, undefined, "depth 1 只展开一层");
  assert.equal(tree!.children![0]!.children_count, 2);
  const text = renderMapTree(mapTree(db).tree!).join("\n");
  assert.match(text, /● o1 组织 · 在跑 1 · 待办 1/);
  assert.match(text, / {4}● o3 派活员（runtime）——项目经理 · 在跑 1/);

  const view = mapNode(db, "o3", [
    {
      ref: running.ref,
      status: "running",
      worker: "claude+opus",
      started_at: 1,
      queued_at: null,
      reason: null,
      log_at: 5,
      action: { text: "改 runner.ts", kind: "edit" },
    },
  ]);
  assert.deepEqual(
    view.chain.map((c) => c.ref),
    ["o1", "o2", "o3"],
  );
  assert.equal(view.tasks.running[0]!.action, "改 runner.ts");
  assert.equal(view.points[0]!.text, "不采信自述");
  assert.equal(view.points_chain[0]!.node, "o2");
  assert.deepEqual(view.links.prs, [
    {
      task: running.ref,
      title: "修派活",
      url: "https://github.com/x/y/pull/9",
    },
  ]);
  assert.deepEqual(view.links.issues, [
    { number: 5, url: "https://github.com/x/y/issues/5" },
  ]);
  const atrium = mapNode(db, "atrium");
  assert.deepEqual(
    atrium.overview.parts.map((p) => p.ref),
    ["o3", "o4"],
  );
  assert.equal("concerns" in atrium, false, "节点不带专员栏");
  const before = mapSignature(db);
  point(db, "o4", "新要点");
  assert.notEqual(mapSignature(db), before, "要点变了指纹就变");
});

test("全景节点给网页页签用的字段：部分做什么与下面几块、专员何时请与在盯几件、下层要点、合入阶段", () => {
  const db = memory();
  editMap(db, "o3", { what: "派活和验收" }, "u1");
  editMap(db, "o5", { what: "凭据与权限" }, "u1");
  node(db, { parent: "o3", slug: "gates", kind: "module", name: "gates" });
  node(db, { parent: "o3", slug: "质量", kind: "concern", name: "质量" });
  db.prepare(
    "UPDATE org_docs SET fields=json_set(fields,'$.invite_when',json(?)) WHERE doc='charter' AND node_id=5",
  ).run(JSON.stringify(["凭据", "server/auth*", 3]));
  point(db, "o2", "本块要点");
  point(db, "o7", "gates 的要点");
  point(db, "o5", "安全的要点");
  const id = (t: { ref: string }) => Number(t.ref.slice(1));
  const watched = createTask(db, { title: "改登录", part: "o4" });
  const merging = createTask(db, { title: "等合入", part: "o4" });
  const closed = createTask(db, { title: "已结", part: "o4" });
  db.prepare(
    "UPDATE tasks SET status='done',delivery_stage='merge_queued',started_at=1,ended_at=9 WHERE id=?",
  ).run(id(merging));
  db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(id(closed));
  for (const t of [watched, merging, closed])
    db.prepare(
      "INSERT INTO task_concerns(task_id,node_id,pos) VALUES(?,5,0)",
    ).run(id(t));

  const view = mapNode(db, "o2");
  const runtime = view.overview.parts.find((p) => p.ref === "o3") as never as {
    what: string;
    parts: number;
  };
  assert.equal(runtime.what, "派活和验收");
  assert.equal(runtime.parts, 1, "下面几块不算专员");
  assert.equal("concerns" in view, false, "节点不再列专员");
  assert.deepEqual(
    view.points_below.map((l) => [l.node, l.points.map((p) => p.text)]),
    [["o7", ["gates 的要点"]]],
    "只列下层部分的要点，深度优先，空块省略",
  );
  assert.equal(view.points[0]!.text, "本块要点");
  const queued = view.tasks.recent.find((t) => t.title === "等合入")!;
  assert.equal(queued.delivery_stage, "merge_queued");
  assert.equal(queued.ended_at, 9);
  assert.equal(view.tasks.recent[0]!.title, "等合入", "等合入排在已结任务前面");
});

// ---- 写：权限与字段 ----

test("map edit/add：并字段、空串清掉；越权与根节点只有 u1；坏输入用参数名报错", () => {
  assert.deepEqual(
    mergeFields(
      { what: "旧", uses: ["a"], goal: "留着" },
      { what: "", uses: ["x", " ", "y"], now: " 现状 " },
    ),
    { uses: ["x", "y"], goal: "留着", now: "现状" },
  );
  assert.throws(() => mergeFields({}, { owner: "x" }), /--owner: 不是全景字段/);
  const db = memory();
  assert.deepEqual(editMap(db, "o3", { now: "在做" }, "a2"), { node: "o3" });
  assert.deepEqual(editMap(db, "o3", { next: "下一步" }, "a1"), {
    node: "o3",
  });
  const charter = () =>
    db
      .prepare("SELECT * FROM org_docs WHERE node_id=3 AND doc='charter'")
      .get() as {
      rev: number;
      fields: string;
      body: string;
    };
  const revisions = () =>
    db
      .prepare(
        "SELECT rev,snapshot FROM org_revisions WHERE node_id=3 AND target='charter' ORDER BY rev",
      )
      .all();
  assert.equal(charter().rev, 0);
  assert.deepEqual(JSON.parse(charter().fields), {
    now: "在做",
    next: "下一步",
  });
  assert.deepEqual(revisions(), []);
  assert.equal(
    (history(db, "o3", { target: "charter" }) as { items: unknown[] }).items
      .length,
    0,
  );
  assert.throws(
    () => editMap(db, "o2", { now: "越权" }, "a2"),
    (e: { statusCode: number }) => e.statusCode === 403,
  );
  assert.throws(
    () => editMap(db, "o1", { now: "根" }, "a1"),
    (e: { statusCode: number }) => e.statusCode === 403,
  );
  assert.throws(() => editMap(db, "o3", { now: "在做" }, "a2"), /没有要改的/);
  assert.throws(
    () => editMap(db, "o3", { what: "长".repeat(301) }, "a2"),
    /charter.what 超过 300 字/,
  );
  assert.throws(
    () => editMap(db, "o3", { now: "x", rev: "r1" }, "a2"),
    /--rev: 只用于 --detail/,
  );
  assert.deepEqual(
    editMap(db, "o3", { now: "新现状", detail: "正文一", rev: "r0" }, "a2"),
    { node: "o3", before: "r0", rev: "r1" },
  );
  assert.equal(charter().body, "正文一");
  assert.equal(charter().rev, 1);
  assert.deepEqual(JSON.parse(revisions()[0]!.snapshot as string).fields, {});
  editMap(db, "o3", { now: "再更新" }, "a2");
  assert.equal(charter().rev, 1);
  assert.equal(revisions().length, 1);
  assert.throws(
    () => editMap(db, "o3", { detail: "正文二", rev: "r0" }, "a2"),
    /已是 r1/,
  );
  editMap(db, "o3", { detail: "正文二", rev: "r1" }, "a2");
  assert.equal(revisions().length, 2);
  const diff = history(db, "o3", { target: "charter", rev: "r2" }) as {
    changes: Record<string, unknown>;
  };
  assert.equal(diff.changes["fields.now"], undefined);
  revertDoc(db, "o3", "charter", "r1", "回退正文", "a2");
  assert.equal(JSON.parse(charter().fields).now, "再更新");
  assert.equal(charter().body, "正文一");
  const added = addMap(
    db,
    { parent: "o2", name: "新部分", slug: "new-part", what: "一句话" },
    "a1",
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM org_revisions WHERE node_id=? AND target='charter'",
      )
      .get(Number(added.node.slice(1)))!.n,
    0,
  );
});

// ---- 接口：认证、一次性链接、非本机、只读 ----

async function service(t: { after: (fn: () => unknown) => void }) {
  const data = mkdtempSync(join(tmpdir(), "atrium-map-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const created = await createApp({
    data,
    tasks: { pace: async () => undefined },
    mapPollMs: 20,
  });
  t.after(() => created.app.close());
  seed(created.db);
  const bearer = `Bearer ${readFileSync(userTokenPath(data), "utf8").trim()}`;
  return { ...created, bearer };
}
const host = { host: "127.0.0.1" };

test("接口：令牌读写；网页登录链接只能用一次，会话只能读全景", async (t) => {
  const { app, bearer } = await service(t);
  const auth = { ...host, authorization: bearer };
  for (const url of ["/api/map/tree", "/api/map/nodes/o2", "/api/map/now"])
    assert.equal((await app.inject({ url, headers: host })).statusCode, 401);
  const tree = await app.inject({
    url: "/api/map/tree?depth=1",
    headers: auth,
  });
  assert.equal(tree.json().root, "o1");
  const withTree = await app.inject({
    url: "/api/map/nodes/atrium?depth=1",
    headers: auth,
  });
  assert.equal(withTree.json().tree.children.length, 2);
  const edited = await app.inject({
    method: "PATCH",
    url: "/api/map/nodes/o3?as=a2",
    headers: auth,
    payload: { what: "派活", uses: ["派一个任务"] },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  const denied = await app.inject({
    method: "PATCH",
    url: "/api/map/nodes/o2?as=a2",
    headers: auth,
    payload: { what: "越权" },
  });
  assert.equal(denied.statusCode, 403);
  const added = await app.inject({
    method: "POST",
    url: "/api/map/nodes",
    headers: auth,
    payload: { parent: "o3", name: "待办本", slug: "ledger", analogy: "白板" },
  });
  assert.equal(added.statusCode, 201, added.body);
  assert.equal(added.json().kind, "module");
  const context = await app.inject({
    url: "/api/map/context/o7?max=300",
    headers: auth,
  });
  assert.match(context.json().text, /Atrium → runtime → 待办本（白板）/);
  assert.equal(
    (await app.inject({ url: "/api/map/context/o7?max=9", headers: auth }))
      .statusCode,
    400,
  );

  // 登录链接：没有令牌签不了；签出的 code 换一次会话后作废。
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/map/login", headers: host }))
      .statusCode,
    401,
  );
  const link = await app.inject({
    method: "POST",
    url: "/api/map/login",
    headers: auth,
  });
  const path = link.json().path as string;
  assert.match(path, /^\/map\/login\?code=[a-f0-9]{64}$/);
  const page = await app.inject({ url: "/map", headers: host });
  assert.equal(page.statusCode, 401);
  assert.match(page.body, /在终端运行[\s\S]*atrium map/);
  const login = await app.inject({ url: `${path}&node=o3`, headers: host });
  assert.equal(login.statusCode, 303);
  assert.equal(login.headers.location, "/map#o3");
  const cookie = String(login.headers["set-cookie"]);
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  const again = await app.inject({ url: path, headers: host });
  assert.equal(again.statusCode, 401, "一次性链接不能再用");
  assert.equal(again.headers["set-cookie"], undefined);
  const evil = await app.inject({
    url: `${path.replace(/code=.*/, "code=x")}&node=javascript:1`,
    headers: host,
  });
  assert.equal(evil.statusCode, 401);

  const session = { ...host, cookie: cookie.split(";")[0]! };
  const html = await app.inject({ url: "/map", headers: session });
  assert.equal(html.statusCode, 200);
  assert.match(
    String(html.headers["content-security-policy"]),
    /default-src 'none'/,
  );
  assert.match(html.body, /<script type="module" src="\/map\/app.js">/);
  for (const url of [
    "/map/app.js",
    "/map/format.js",
    "/map/style.css",
    "/api/map/tree",
    "/api/map/nodes/o2",
    "/api/map/now",
    "/api/map/roles",
    "/api/map/specialists",
  ])
    assert.equal(
      (await app.inject({ url, headers: session })).statusCode,
      200,
      url,
    );
  const missingSpecialist = await app.inject({
    url: "/api/map/specialists/r1",
    headers: session,
  });
  assert.equal(missingSpecialist.statusCode, 404);
  assert.equal(missingSpecialist.json().code, "not_found");
  // 会话只读全景：写全景、签新链接、读别的接口都要用户令牌。
  for (const [method, url] of [
    ["PATCH", "/api/map/nodes/o3"],
    ["POST", "/api/map/nodes"],
    ["POST", "/api/map/login"],
    ["GET", "/api/map/context/o3"],
    ["GET", "/api/tasks"],
    ["GET", "/api/org/tree"],
  ] as const) {
    const response = await app.inject({
      method,
      url,
      headers: session,
      ...(method === "GET" ? {} : { payload: {} }),
    });
    assert.equal(response.statusCode, 403, `${method} ${url}`);
    assert.equal(response.json().code, "map_session_forbidden");
    assert.match(response.json().error, /Atrium 的问题，不是你的登录/);
  }
  // 非本机：连接地址不是回环或 Host 不是本机都拒绝，带着有效会话也不行。
  const remote = await app.inject({
    url: "/api/map/tree",
    headers: session,
    remoteAddress: "10.0.0.2",
  });
  assert.equal(remote.statusCode, 403);
  assert.equal(
    (
      await app.inject({
        url: path,
        headers: session,
        remoteAddress: "192.168.1.9",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: "/map",
        headers: { ...session, host: "evil.example" },
      })
    ).statusCode,
    403,
  );
  assert.equal(authPolicy("GET", "/api/map/context/:id"), "user");
  assert.equal(authPolicy("PATCH", "/api/map/nodes/:id"), "user");
});

test("登录链接过期、伪造与会话过期", () => {
  const db = new DatabaseSync(":memory:");
  let now = 1_000_000;
  const login = new MapLogin(db, () => now);
  const link = login.link();
  now += LINK_TTL_MS + 1;
  assert.equal(login.exchange(link.token), null, "过期");
  const fresh = login.link();
  assert.equal(login.exchange("f".repeat(64)), null, "伪造");
  assert.equal(login.exchange("../etc"), null);
  const session = login.exchange(fresh.token)!;
  assert.ok(session);
  assert.equal(login.exchange(fresh.token), null, "用过");
  assert.equal(login.valid(`a=1; atrium_map=${session.token}`), true);
  assert.equal(
    login.valid(`atrium_map=${fresh.token}`),
    false,
    "登录码不是会话",
  );
  assert.equal(cookieOf("atrium_map=zz"), null);
  now += 8 * 24 * 3600_000;
  assert.equal(login.valid(`atrium_map=${session.token}`), false, "会话过期");
  for (let i = 0; i < 40; i++) login.link();
  const rows = db.prepare("SELECT count(*) AS n FROM map_login").get() as {
    n: number;
  };
  assert.ok(rows.n <= 20, "有界");
});

test("失效通知：数据变了推 changed，网页据此局部重取", async (t) => {
  const { app, db, bearer } = await service(t);
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const events: string[] = [];
  const done = new Promise<void>((resolve, reject) => {
    const req = request(
      `${address}/api/map/stream`,
      { headers: { authorization: bearer } },
      (res) => {
        assert.equal(
          res.headers["content-type"],
          "text/event-stream; charset=utf-8",
        );
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          for (const m of chunk.matchAll(/event: (\w+)/g)) events.push(m[1]!);
          if (events.includes("hello") && !events.includes("changed"))
            point(db, "o2", "新要点");
          if (events.includes("changed")) {
            req.destroy();
            resolve();
          }
        });
      },
    );
    req.on("error", (error) => {
      if (!events.includes("changed")) reject(error);
    });
    req.end();
  });
  await done;
  assert.deepEqual(events.slice(0, 2), ["hello", "changed"]);
});
