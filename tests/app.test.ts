import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { authPolicy } from "../server/auth-policy.ts";
import { userTokenPath } from "../server/user-auth.ts";

/** 组织运行时的精简入口（#291）：只有认证、任务、组织、额度与事件路由。 */
async function open(t: { after: (fn: () => unknown) => void }, auth = true) {
  const data = mkdtempSync(join(tmpdir(), "atrium-app-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const routes: { method: string; url: string }[] = [];
  const created = await createApp({
    data,
    auth,
    controlToken: "c".repeat(64),
    onRoute: (method, url) => routes.push({ method, url }),
    tasks: { pace: async () => undefined },
  });
  t.after(() => created.app.close());
  const bearer = `Bearer ${readFileSync(userTokenPath(data), "utf8").trim()}`;
  return { ...created, data, routes, bearer };
}
const host = { host: "127.0.0.1" };

test("精简入口只注册新运行时路由，除令牌轮换外一律要求用户凭据", async (t) => {
  const { app, routes } = await open(t);
  const prefixes = [
    ...new Set(
      routes.map(({ url }) =>
        url.startsWith("/api/") ? url.split("/")[2] : url.split("/")[1],
      ),
    ),
  ];
  assert.deepEqual(prefixes.sort(), [
    "auth",
    "events",
    "goals",
    "leaders",
    "map",
    "org",
    "quota",
    "reviews",
    "roles",
    "skill-proposals",
    "skills",
    "tasks",
    "workers",
  ]);
  // 全景网页（#322）的页面与只读接口另认本机会话；其余一律要用户凭据。
  const exceptions = routes
    .filter(
      ({ method, url }) =>
        method !== "HEAD" && authPolicy(method, url) !== "user",
    )
    .map(({ method, url }) => `${method} ${url}`);
  assert.deepEqual(exceptions.sort(), [
    "GET /api/map/nodes/:id",
    "GET /api/map/now",
    "GET /api/map/stream",
    "GET /api/map/tree",
    "GET /map",
    "GET /map/app.js",
    "GET /map/login",
    "GET /map/style.css",
    "POST /api/auth/rotate",
  ]);
  for (const { method, url } of routes) {
    const response = await app.inject({
      method: method as "GET",
      url: url.replace(/:[\w]+/g, "t1"),
      headers: host,
    });
    assert.equal(response.statusCode, 401, `${method} ${url} 应要求凭据`);
  }
  // 旧运行时的接口不再存在；未匹配的路径也先要凭据，编码过的 /api 同样挡住。
  for (const url of ["/api/overview", "/%61pi/agents", "/", "/mcp/x"]) {
    const response = await app.inject({ url, headers: host });
    assert.equal(response.statusCode, 401, url);
  }
});

test("带用户凭据：旧接口 404，新接口可用；实例控制凭据可轮换用户令牌", async (t) => {
  const { app, bearer, data } = await open(t);
  const headers = { ...host, authorization: bearer };
  assert.equal(
    (await app.inject({ url: "/api/overview", headers })).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ url: "/api/org/tree", headers })).statusCode,
    200,
  );
  const rotated = await app.inject({
    method: "POST",
    url: "/api/auth/rotate",
    headers: { ...host, authorization: `Bearer ${"c".repeat(64)}` },
  });
  assert.equal(rotated.statusCode, 200);
  assert.equal(
    (await app.inject({ url: "/api/org/tree", headers })).statusCode,
    401,
    "旧令牌轮换后失效",
  );
  const fresh = readFileSync(userTokenPath(data), "utf8").trim();
  assert.equal(
    (
      await app.inject({
        url: "/api/org/tree",
        headers: { ...host, authorization: `Bearer ${fresh}` },
      })
    ).statusCode,
    200,
  );
});

test("--as 只认 u1 与组织节点 leader 的短号；leader 只收短号", async (t) => {
  const { app } = await open(t, false);
  const post = (url: string, payload: object) =>
    app.inject({ method: "POST", url, headers: host, payload });
  const root = await post("/api/org/nodes", {
    slug: "org",
    kind: "org",
    name: "组织",
    reason: "创建",
  });
  assert.equal(root.statusCode, 201, root.body);
  // 指派 aN 前须先登记。
  const unregistered = await post("/api/org/nodes", {
    parent: "o1",
    slug: "atrium",
    kind: "project",
    name: "Atrium",
    leader: "a1",
    reason: "创建",
  });
  assert.equal(unregistered.statusCode, 404);
  assert.match(unregistered.json().error, /a1 没有登记为 leader/);
  const registered = await post("/api/leaders", {
    name: "Atrium 负责人",
    worker: "claude+opus",
  });
  assert.equal(registered.statusCode, 201, registered.body);
  assert.equal(registered.json().ref, "a1");
  const project = await post("/api/org/nodes", {
    parent: "o1",
    slug: "atrium",
    kind: "project",
    name: "Atrium",
    leader: "a1",
    reason: "创建",
  });
  assert.equal(project.statusCode, 201, project.body);
  // a1 是 o2 的 leader，可以在自己名下建模块；a2 不是任何节点的 leader。
  const child = await post("/api/org/nodes?as=a1", {
    parent: "o2",
    slug: "runtime",
    kind: "module",
    name: "runtime",
    reason: "创建",
  });
  assert.equal(child.statusCode, 201, child.body);
  const stranger = await post("/api/org/nodes?as=a2", {
    parent: "o2",
    slug: "cli",
    kind: "module",
    name: "cli",
    reason: "创建",
  });
  assert.equal(stranger.statusCode, 404);
  assert.match(stranger.json().error, /a2 不是任何组织节点的 leader/);
  // 名称、内部 ID 与旧的字面量 user 都不再当身份解析。
  for (const as of ["甲", "user", "a0", "u2"]) {
    const response = await post(`/api/org/nodes?as=${encodeURI(as)}`, {
      parent: "o2",
      slug: "x",
      kind: "module",
      name: "x",
      reason: "创建",
    });
    assert.equal(response.statusCode, 400, as);
  }
  const named = await app.inject({
    method: "PATCH",
    url: "/api/org/nodes/o3",
    headers: host,
    payload: { leader: "甲", reason: "换人" },
  });
  assert.equal(named.statusCode, 400);
  assert.match(named.json().error, /leader 应为 u1 或 aN/);
  const cleared = await app.inject({
    method: "PATCH",
    url: "/api/org/nodes/o2",
    headers: host,
    payload: { leader: "none", reason: "空缺" },
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  // o2 不再由 a1 领导，a1 随之失去操作资格。
  const demoted = await post("/api/org/nodes?as=a1", {
    parent: "o2",
    slug: "y",
    kind: "module",
    name: "y",
    reason: "创建",
  });
  assert.equal(demoted.statusCode, 404);
});

test("旧运行时留下的表原样保留，精简入口照常启动且不读写它们", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-app-legacy-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const legacy = new DatabaseSync(join(data, "atrium.sqlite"));
  legacy.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO agents VALUES ('x','旧身份');
    CREATE TABLE inbox_tokens (agent_id TEXT PRIMARY KEY REFERENCES agents(id), token_hash TEXT);
    CREATE TABLE user_auth (id INTEGER PRIMARY KEY CHECK(id=1), token_hash TEXT NOT NULL);`);
  legacy.close();
  const { app, db } = await createApp({
    data,
    auth: false,
    tasks: { pace: async () => undefined },
  });
  try {
    const tree = await app.inject({ url: "/api/org/tree", headers: host });
    assert.equal(tree.statusCode, 200);
    assert.deepEqual(
      db
        .prepare("SELECT id,name FROM agents")
        .all()
        .map((row) => ({ ...row })),
      [{ id: "x", name: "旧身份" }],
    );
  } finally {
    await app.close();
  }
});
