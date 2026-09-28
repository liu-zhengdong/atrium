import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { authPolicy } from "../server/auth-policy.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode } from "../server/org/write.ts";
import { addPoint } from "../server/org/points.ts";
import { CONTEXT_MAX, mapContext, taskContext } from "../server/map/context.ts";
import { MapLogin, LINK_TTL_MS, cookieOf } from "../server/map/login.ts";
import { addMap, editMap, mergeFields } from "../server/map/write.ts";
import {
  expandPlan,
  mapNode,
  mapTree,
  mapSignature,
  taskView,
  TASK_LINE_WIDTH,
} from "../server/map/view.ts";
import { width } from "../server/text-width.ts";
import { renderMapTree } from "../cli/map.ts";
import { createTask, ensureTaskTables } from "../server/tasks/ledger/ledger.ts";
import { removeTemp } from "./temp-dir.ts";
import { ensureHostTables } from "../server/hosts/model.ts";

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
  // 旧库里的关注点（已下线，不能再建）：直接写进表。
  db.prepare(
    "INSERT INTO org_nodes(parent_id,kind,slug,name,created_at,updated_at) VALUES(2,'concern','安全','安全',1,1)",
  ).run();
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

test("map context：读库时只附本部门及上级的要点（按层、按排序）与技能，不附位置与人话字段", () => {
  const db = memory();
  editMap(db, "o2", { what: "AI 组织的运行底座", alias: "底座" }, "u1");
  editMap(db, "o4", { what: "命令行入口", analogy: "前台" }, "u1");
  point(db, "o2", "随时升级");
  point(db, "o4", "网页只读");
  point(db, "o6", "别处的要点");
  const context = mapContext(db, "atrium/cli");
  assert.equal(context.ref, "o4");
  assert.equal(context.max, CONTEXT_MAX);
  assert.match(
    context.text,
    /\[Atrium\]\n1\. 随时升级（随时升级的理由）\n\[cli\]\n1\. 网页只读/,
  );
  for (const gone of ["别处的要点", "全景位置", "命令行入口", "底座"])
    assert.doesNotMatch(context.text, new RegExp(gone));
  assert.equal(taskContext(db, 4), context.text);
  assert.equal(taskContext(db, null), undefined);
  assert.equal(taskContext(db, 99), undefined);
});

// ---- 读视图 ----

test("全景树与节点：按归属部门汇总任务，专员单列，要点与上级要点分开", () => {
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

test("全景任务行：远程执行机器带名字与离线标记", () => {
  const db = memory();
  ensureHostTables(db);
  const now = Date.now();
  db.prepare(
    "INSERT INTO hosts(id,name,kind,repos,joined_at,last_seen_at,created_at,updated_at) VALUES(3,'ggb','remote','[]',1,?,?,?)",
  ).run(now, now, now);
  const task = createTask(db, { title: "远程任务", part: "o3" });
  db.prepare(
    "UPDATE tasks SET status='running',worker='claude+opus',host_id=3 WHERE id=?",
  ).run(task.id);
  assert.equal(mapNode(db, "o3").tasks.running[0]!.host_name, "ggb");
  db.prepare("UPDATE hosts SET last_seen_at=? WHERE id=3").run(now - 61_000);
  assert.equal(mapNode(db, "o3").tasks.running[0]!.host_name, "ggb（离线）");
  db.prepare("UPDATE tasks SET host_id=NULL WHERE id=?").run(task.id);
  assert.equal(mapNode(db, "o3").tasks.running[0]!.host_name, null);
  db.close();
});

test("全景节点给网页页签用的字段：部门做什么与下面几块、下层要点、合入阶段", () => {
  const db = memory();
  editMap(db, "o3", { what: "派活和验收" }, "u1");
  editMap(db, "o5", { what: "凭据与权限" }, "u1");
  node(db, { parent: "o3", slug: "gates", kind: "module", name: "gates" });
  db.prepare(
    "INSERT INTO org_nodes(parent_id,kind,slug,name,created_at,updated_at) VALUES(3,'concern','质量','质量',1,1)",
  ).run();
  point(db, "o2", "本块要点");
  point(db, "o7", "gates 的要点");
  point(db, "o5", "安全的要点");
  const id = (t: { ref: string }) => Number(t.ref.slice(1));
  createTask(db, { title: "改登录", part: "o4" });
  const merging = createTask(db, { title: "等合入", part: "o4" });
  const closed = createTask(db, { title: "已结", part: "o4" });
  db.prepare(
    "UPDATE tasks SET status='done',delivery_stage='merge_queued',started_at=1,ended_at=9 WHERE id=?",
  ).run(id(merging));
  db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(id(closed));

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
    "只列下层部门的要点，深度优先，空块省略",
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
      { what: "旧", uses: ["a"], goal: "已下线的字段丢掉" },
      { what: "", uses: ["x", " ", "y"], now: " 现状 " },
    ),
    { uses: ["x", "y"], now: "现状" },
  );
  assert.throws(() => mergeFields({}, { owner: "x" }), /--owner: 不是全景字段/);
  const db = memory();
  assert.deepEqual(editMap(db, "o3", { now: "在做" }, "a2"), { node: "o3" });
  assert.deepEqual(editMap(db, "o3", { next: "下一步" }, "a1"), {
    node: "o3",
  });
  const stored = () =>
    JSON.parse(
      (
        db
          .prepare(
            "SELECT fields FROM org_docs WHERE node_id=3 AND doc='charter'",
          )
          .get() as { fields: string }
      ).fields,
    );
  assert.deepEqual(stored(), { now: "在做", next: "下一步" });
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM org_revisions WHERE target<>'node'")
      .get()!.n,
    0,
    "人话字段不留修订",
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
    /fields.what 超过 300 字/,
  );
  // 阶段记录并进 map edit：整份替换，按字段名校验。
  editMap(
    db,
    "o3",
    { stages: [{ id: "g1", result: "跑通", status: "active" }] },
    "a2",
  );
  assert.equal(stored().stages[0].id, "g1");
  assert.throws(
    () =>
      editMap(
        db,
        "o3",
        { stages: [{ id: "g1", result: "x", status: "x" }] },
        "a2",
      ),
    /fields.stages\[0\]\.status 只能是/,
  );
  const added = addMap(
    db,
    { parent: "o2", name: "新部门", slug: "new-part", what: "一句话" },
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
  t.after(() => removeTemp(data));
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
  assert.equal(context.statusCode, 200, context.body);
  assert.equal(context.json().ref, "o7");
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
    "/map/boot.js",
    "/map/format.js",
    "/map/style.css",
    "/api/map/tree",
    "/api/map/nodes/o2",
    "/api/map/now",
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

test("全景任务行：原因、最近动作、备注都只出一行，按显示宽度截断", () => {
  const essay = `审阅打回（t132，codex）：## 必须改的问题\n1. **性能目标没达到**\n## 可选建议`;
  const long = "中英 mixed 混排".repeat(30);
  const view = taskView(
    { id: 7, title: "t", status: "blocked", part: null, urgent: 0 } as never,
    {
      ref: "t7",
      status: "blocked",
      worker: null,
      started_at: null,
      queued_at: null,
      reason: essay,
      log_at: 0,
      action: { text: `${long}\n第二行`, kind: "step" },
    },
    new Map(),
    {
      by: null,
      note: { text: "看过日志\n细节在下面", at: 1, by: null as never },
    },
  );
  assert.equal(view.reason, "审阅打回（t132，codex）：## 必须改的问题");
  assert.ok(
    width(view.action!) <= TASK_LINE_WIDTH && view.action!.endsWith("…"),
  );
  assert.equal(view.note!.text, "看过日志");
});

test("全景树不因节点多拒绝：按名额广度优先展开，超出的只给个数", () => {
  // 根 1 下 600 个仓库块，每块 3 个模块：共 2401 块。
  const children = new Map<number | null, { id: number }[]>();
  children.set(
    1,
    Array.from({ length: 600 }, (_, i) => ({ id: 2 + i })),
  );
  for (let i = 0; i < 600; i++)
    children.set(
      2 + i,
      [0, 1, 2].map((k) => ({ id: 10_000 + i * 3 + k })),
    );
  const plan = expandPlan(children, 1, 8, 1001);
  assert.equal(plan.get(1), 600);
  const shown = [...plan.values()].reduce((a, b) => a + b, 0);
  assert.equal(shown, 1000);
  assert.equal(plan.get(2), 3);
  assert.equal(plan.get(2 + 132), 3);
  assert.equal(plan.get(2 + 133), 1);
  assert.equal(plan.has(2 + 134), false);
  // 名额不够一层：这一块只给前几块。
  assert.equal(expandPlan(children, 1, 8, 101).get(1), 100);
  // depth 0 不展开；叶子不记。
  assert.equal(expandPlan(children, 1, 0).size, 0);
  assert.equal(expandPlan(children, 10_000, 3).size, 0);
  // depth 1 只展开根。
  assert.deepEqual([...expandPlan(children, 1, 1)], [[1, 600]]);

  const lines = renderMapTree({
    ref: "o1",
    name: "组织",
    alias: "",
    analogy: "",
    kind: "org",
    what: "",
    archived: false,
    dot: "idle",
    tasks: { running: 0, blocked: 0, open: 0 },
    children: [
      {
        ref: "o2",
        name: "仓库",
        alias: "",
        analogy: "",
        kind: "project",
        what: "",
        archived: false,
        dot: "idle",
        tasks: { running: 0, blocked: 0, open: 0 },
        children_count: 0,
      },
    ],
    children_count: 600,
  });
  assert.match(lines.at(-1)!, /还有 599 块这次没展开：atrium map o1 --depth 1/);
});
