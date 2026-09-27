import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtimes } from "../server/runtime.ts";
import { createApp } from "../server/legacy-app.ts";
import { agentName } from "../shared/agent-name.ts";
import {
  displayName,
  type LiveRuntime,
  type Overview,
} from "../shared/schema.ts";

const live = (cwd: string): LiveRuntime => ({
  runtimeId: randomUUID(),
  generation: randomUUID(),
  sessionId: randomUUID(),
  pid: process.pid,
  cwd,
  mode: "tui",
});

test("临时实例不建账号；旧记录兼容关联、并发点击与重启", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-discovery-"));
  let items: unknown[] = [live(data), live(data)];
  const first = items[0] as LiveRuntime;
  let lists = 0;
  // Fake only the ACP transport. Discovery validation, ownership, storage and HTTP run unchanged.
  const transport = Runtimes.prototype as unknown as {
    rpc: (method: string, params: unknown) => Promise<unknown>;
  };
  t.mock.method(transport, "rpc", async (method: string) => {
    assert.equal(method, "_pi/runtime/list");
    lists++;
    return { runtimes: items };
  });
  const pump = t.mock.method(Runtimes.prototype, "pump", async () => {});
  const { app, store, runtimes } = await createApp({ auth: false, data });
  t.after(async () => {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  });
  await runtimes!.discover();
  const overview = () =>
    app.inject({ url: "/api/overview" }).then((r) => r.json<Overview>());
  let before = await overview();
  assert.equal(before.discovery.runtimes.length, 2);
  assert.equal(before.agents.length, 0, "浏览不创建空档案");
  assert.equal(pump.mock.callCount(), 0, "浏览不连接 Pi");
  const coldLists = lists;
  await Promise.all(Array.from({ length: 20 }, () => overview()));
  assert.equal(lists, coldLists, "UI 热刷新不重扫全部运行时");

  const denied = await app.inject({
    method: "POST",
    url: `/api/runtimes/${first.runtimeId}/chat`,
  });
  assert.equal(denied.statusCode, 409);
  assert.equal(store.agents().length, 0);
  const existing = store.createAgent("旧记录一", realpathSync(data));
  const account = store.run(
    "INSERT INTO accounts(provider,name,type) VALUES('fixture','test','api_key')",
  ).lastInsertRowid;
  // Bind the fixture to expose the existing runtime through discovery.
  store.run(
    "UPDATE agents SET runtime_id=? WHERE id=?",
    first.runtimeId,
    existing.agent.id,
  );
  writeFileSync(
    join(data, "credentials", `${existing.agent.id}.json`),
    JSON.stringify({ token: existing.token }),
    { mode: 0o600 },
  );
  const deniedAccount = await app.inject({
    method: "POST",
    url: `/api/runtimes/${first.runtimeId}/chat`,
  });
  assert.equal(deniedAccount.statusCode, 409);
  assert.equal(deniedAccount.json().code, "unassigned_account");
  store.run(
    "INSERT INTO account_assignments(agent_id,provider,account_number) VALUES(?,?,?)",
    existing.agent.id,
    "fixture",
    account,
  );
  const requests = await Promise.all(
    Array.from({ length: 4 }, () =>
      app.inject({
        method: "POST",
        url: `/api/runtimes/${first.runtimeId}/chat`,
      }),
    ),
  );
  requests.forEach((r) => assert.equal(r.statusCode, 200, r.body));
  assert.equal(new Set(requests.map((r) => r.json().id)).size, 1);
  assert.equal(store.agents().length, 1);
  const agent = store.agents()[0]!;
  assert.equal(requests[0]!.json().direct_agent, agent.id);
  assert.equal(
    store.one<{ runtime_id: string }>(
      "SELECT runtime_id FROM agents WHERE id=?",
      agent.id,
    )!.runtime_id,
    first.runtimeId,
  );
  assert(pump.mock.callCount() > 0, "选择后在后台建立连接");
  const credential = join(data, "credentials", `${agent.id}.json`);
  assert.equal(statSync(credential).mode & 0o777, 0o600);
  assert(
    store.authenticate(
      agent.id,
      JSON.parse(readFileSync(credential, "utf8")).token,
    ),
  );
  before = await overview();
  assert.equal(
    before.discovery.runtimes.filter((r) => !r.bound_agent).length,
    1,
  );
  assert(before.agents[0]!.available);

  // Two sessions in the same cwd must never collapse into one Agent.
  const second = items[1] as LiveRuntime;
  const legacyTwo = store.createAgent("旧记录二", realpathSync(data)).agent;
  store.run(
    "UPDATE agents SET runtime_id=? WHERE id=?",
    second.runtimeId,
    legacyTwo.id,
  );
  store.run(
    "INSERT INTO account_assignments(agent_id,provider,account_number) VALUES(?,?,?)",
    legacyTwo.id,
    "fixture",
    account,
  );
  const secondChat = await app.inject({
    method: "POST",
    url: `/api/runtimes/${second.runtimeId}/chat`,
  });
  assert.equal(secondChat.statusCode, 200);
  assert.equal(store.agents().length, 2);
  assert.notEqual(secondChat.json().direct_agent, agent.id);
  assert.notEqual(store.agents()[0]!.name, store.agents()[1]!.name);

  // /new or /reload keeps the instance identity, but refreshes its generation/session.
  items = [
    { ...first, generation: randomUUID(), sessionId: randomUUID() },
    second,
  ];
  await runtimes!.discover();
  assert.equal((await overview()).discovery.runtimes[0]!.bound_agent, agent.id);
  const observed = (items[0] as LiveRuntime).sessionId;
  const changes = () =>
    store.one<{ n: number }>("SELECT total_changes() AS n")!.n;
  const unchanged = changes();
  await runtimes!.discover();
  await runtimes!.discover();
  assert.equal(changes(), unchanged, "热扫描不重复写入未变化的 Agent 行");
  assert.equal(
    store.one<{ observed_session_id: string }>(
      "SELECT observed_session_id FROM agents WHERE id=?",
      agent.id,
    )!.observed_session_id,
    observed,
  );

  // An offline identity and its chat survive. The same explicitly resumed native
  // session can reconnect, but not while its prior writer is still alive.
  const resumed = { ...first, runtimeId: randomUUID(), sessionId: observed };
  items = [resumed, second];
  await runtimes!.discover();
  assert.equal((await overview()).discovery.runtimes[0]!.bound_agent, null);
  store.run("UPDATE agents SET runtime_pid=NULL WHERE id=?", agent.id);
  items = [resumed, { ...resumed, runtimeId: randomUUID() }, second];
  await runtimes!.discover();
  assert(
    (await overview()).discovery.runtimes
      .slice(0, 2)
      .every((r) => !r.bound_agent),
    "同一会话的并存实例不猜测身份",
  );
  items = [resumed, second];
  await runtimes!.discover();
  assert.equal((await overview()).discovery.runtimes[0]!.bound_agent, agent.id);
  assert.equal(
    store.one<{ runtime_id: string }>(
      "SELECT runtime_id FROM agents WHERE id=?",
      agent.id,
    )!.runtime_id,
    resumed.runtimeId,
  );
  items = [];
  await runtimes!.discover();
  const offline = await overview();
  assert.equal(offline.agents.length, 2);
  assert(offline.agents.every((a) => !a.available));
  assert.equal(offline.chats.length, 2);
  const gone = await app.inject({
    method: "POST",
    url: `/api/runtimes/${resumed.runtimeId}/chat`,
  });
  assert.equal(gone.statusCode, 404);
  assert.equal(store.agents().length, 2);
});

test("发现边界：过滤 RPC 与凭据；坏登记、伪造 ID、无效新建和启动失败", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-discovery-invalid-"));
  const runtime = live(data);
  let items: unknown[] = [
    { ...runtime, token: "secret-not-for-ui", endpoint: "/private" },
    { ...live(data), mode: "rpc" },
  ];
  const transport = Runtimes.prototype as unknown as {
    rpc: (method: string, params: unknown) => Promise<unknown>;
  };
  t.mock.method(transport, "rpc", async () => ({ runtimes: items }));
  t.mock.method(Runtimes.prototype, "pump", async () => {});
  t.mock.method(Runtimes.prototype, "start", async () => {
    throw new Error("fixture startup failure");
  });
  const { app, store, runtimes } = await createApp({
    auth: false,
    data,
    desktops: join(data, "desktops"),
    piHome: join(data, ".pi"),
  });
  t.after(async () => {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  });
  await runtimes!.discover();
  let result = await app.inject({ url: "/api/overview" });
  assert.equal(result.json().discovery.runtimes.length, 1);
  assert(!result.body.includes("secret-not-for-ui"));
  assert(!("endpoint" in result.json().discovery.runtimes[0]));
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/runtimes/not-a-uuid/chat" }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/runtimes/${randomUUID()}/chat`,
      })
    ).statusCode,
    404,
  );
  items = [{ ...runtime, pid: -1 }];
  await runtimes!.discover();
  result = await app.inject({ url: "/api/overview" });
  assert(result.json().discovery.error);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/runtimes/${runtime.runtimeId}/chat`,
      })
    ).statusCode,
    503,
  );
  assert.equal(store.agents().length, 0);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/agents",
        payload: { name: "bad", start: "yes" },
      })
    ).statusCode,
    400,
  );
  const failed = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { name: "启动失败样本", template: data, start: true },
  });
  assert.equal(failed.statusCode, 409);
  assert.equal(failed.json().code, "unassigned_account");
  assert.equal(store.agents().length, 0, "未分配时拒绝创建并启动的组合操作");
});

test("自动名称可读、有界、符合名称约束，重名不复用 UUID", () => {
  for (const cwd of [
    "/",
    "/tmp/工作目录",
    "C:\\work\\project",
    "/tmp/a@b😀",
    "/tmp/" + "界".repeat(150),
  ]) {
    const first = agentName(cwd);
    const second = agentName(cwd, [first]);
    assert(displayName.safeParse(first).success);
    assert(displayName.safeParse(second).success);
    assert.notEqual(first, second);
    assert(second.length <= 40);
  }
  assert.equal(agentName("/repo", ["repo", "repo 2"]), "repo 3");
});
