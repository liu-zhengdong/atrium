import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { alive, packageRoot } from "../server/service-state.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { Problem } from "../server/problem.ts";
import { createApp } from "../server/legacy-app.ts";
import { client } from "../cli/service.ts";
import {
  agentWaitQuery,
  readBusySince,
  reconnectingWait,
} from "../cli/wait-options.ts";
import { childEnv } from "./child-env.ts";

test("--idle 真断开：body 读不出来当断连重连，不误报空闲", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-idle-crash-"));
  const { app, store, runtimes, pendingWaits } = await createApp({
    auth: false,
    data,
    desktops: join(data, "desktops"),
    piHome: join(data, "pi"),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await app.close();
    rmSync(data, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const agent = store.createAgent("忙碌身份", data).agent;
  const chat = store.createChat("测试", [agent.id], agent.id);
  type RuntimeConnection =
    NonNullable<typeof runtimes>["connections"] extends Map<string, infer T>
      ? T
      : never;
  const entry: RuntimeConnection = {
    connection: null as unknown as RuntimeConnection["connection"],
    info: {
      runtimeId: agent.id,
      generation: agent.id,
      sessionId: agent.id,
      pid: process.pid,
      ownerPid: null,
      sessionFile: null,
      cwd: data,
      mode: "rpc" as const,
      busy: true,
      model: "test",
    },
  };
  runtimes!.connections.set(agent.id, entry);
  // client 只要求本地令牌形状合法；auth:false 不校验内容
  writeFileSync(userTokenPath(data), "a".repeat(64));
  const wait = client(origin, data);
  const pending = reconnectingWait<{
    status: string;
    finished_at: number | null;
    timed_out: boolean;
    restarting?: boolean;
  }>({
    seconds: 20,
    request: (timeout) =>
      wait.get(`/agents/${agent.id}/wait?timeout=${timeout}`),
    restarting: (result) => result.restarting === true,
    resume: () => `atrium wait ${agent.ref} --idle`,
  });
  for (let i = 0; i < 50 && pendingWaits() !== 1; i++) await delay(100);
  assert.equal(pendingWaits(), 1, "等待要先挂上（头已发出）");
  // 真断开：200 头已发，body 中途被掐断
  app.server.closeAllConnections();
  // 断开后要自动重连并重新挂上（此刻还忙着）；若被当成正常结果返回，这里永远等不到
  for (let i = 0; i < 50 && pendingWaits() !== 0; i++) await delay(100);
  assert.equal(pendingWaits(), 0, "断开的等待要被服务端清理");
  for (let i = 0; i < 50 && pendingWaits() !== 1; i++) await delay(100);
  assert.equal(pendingWaits(), 1, "断开后要重连并重新挂上等待");
  await delay(300);
  entry.info.busy = false;
  // 唤醒已重新注册的等待者（与 wait.test.ts 同一路径）
  // 唤醒可能已重新注册的等待者（与 wait.test.ts 同一路径）
  await fetch(`${origin}/api/chats/${chat.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned: true }),
  });
  const result = await pending;
  assert.equal(
    result.status,
    "idle",
    "重连后按真实状态返回，既不是 {} 也不是误报空闲",
  );
  assert.equal(result.timed_out, false);
  assert.equal(typeof result.finished_at, "number");
});

test("--idle 崩溃间隙：runtime_pid 活着但没接上时继续等，接上后按真实状态返回", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-idle-unbound-"));
  const { app, store, runtimes, pendingWaits } = await createApp({
    auth: false,
    data,
    desktops: join(data, "desktops"),
    piHome: join(data, "pi"),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const pi = spawn("sleep", ["60"]);
  t.after(async () => {
    app.server.closeAllConnections();
    await app.close();
    pi.kill("SIGKILL");
    rmSync(data, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const agent = store.createAgent("未接上身份", data).agent;
  const chat = store.createChat("唤醒", [agent.id], agent.id);
  // 模拟崩溃后的新服务：存储里 runtime_pid 还活着（Pi 没死），连接还没接上。
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  db.prepare("UPDATE agents SET runtime_pid=? WHERE id=?").run(
    pi.pid!,
    agent.id,
  );
  db.close();
  writeFileSync(userTokenPath(data), "a".repeat(64));
  const wait = client(origin, data);
  type RuntimeConnection =
    NonNullable<typeof runtimes>["connections"] extends Map<string, infer T>
      ? T
      : never;
  let settled = false;
  const first = reconnectingWait<{
    status: string;
    finished_at: number | null;
    timed_out: boolean;
    restarting?: boolean;
  }>({
    seconds: 20,
    request: (timeout) =>
      wait.get(`/agents/${agent.id}/wait?timeout=${timeout}`),
    restarting: (result) => result.restarting === true,
    resume: () => `atrium wait ${agent.ref} --idle`,
  }).then((result) => {
    settled = true;
    return result;
  });
  for (let i = 0; i < 50 && pendingWaits() !== 1; i++) await delay(100);
  assert.equal(pendingWaits(), 1, "等待要先挂上");
  await delay(500);
  assert.equal(
    settled,
    false,
    "进程还活着、没接上之前，--idle 既不能报空闲也不能报离线",
  );
  // 接上后按真实状态返回：这一轮并没在跑。
  const entry: RuntimeConnection = {
    connection: null as unknown as RuntimeConnection["connection"],
    info: {
      runtimeId: agent.id,
      generation: agent.id,
      sessionId: agent.id,
      pid: pi.pid!,
      ownerPid: null,
      sessionFile: null,
      cwd: data,
      mode: "rpc" as const,
      busy: false,
      model: "test",
    },
  };
  runtimes!.connections.set(agent.id, entry);
  await fetch(`${origin}/api/chats/${chat.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned: true }),
  });
  const result = await first;
  assert.equal(result.status, "idle", "接上后按真实状态返回");
  assert.equal(result.timed_out, false);
  assert.equal(result.finished_at, null, "没观察到忙碌就不编造本轮结束");
  // 进程没了才报离线。
  runtimes!.connections.delete(agent.id);
  pi.kill("SIGKILL");
  for (let i = 0; i < 50 && alive(pi.pid!); i++) await delay(100);
  assert.equal(alive(pi.pid!), false, "测试前提：进程要真的死掉");
  const second = await reconnectingWait<{
    status: string;
    finished_at: number | null;
    timed_out: boolean;
    restarting?: boolean;
  }>({
    seconds: 10,
    request: (timeout) =>
      wait.get(`/agents/${agent.id}/wait?timeout=${timeout}`),
    restarting: (result) => result.restarting === true,
    resume: () => `atrium wait ${agent.ref} --idle`,
  });
  assert.equal(second.status, "offline", "进程没了才报离线");
  assert.equal(second.timed_out, false);
});

test("reconnectingWait：断连与 restarting 都重连，耗尽给 503 与续等命令", async () => {
  // a) restarting → 带服务端游标重连后成功
  const calls: number[] = [];
  let first = true;
  const ok = await reconnectingWait<{ after: number; restarting?: boolean }>({
    seconds: 5,
    cursor: 7,
    request: async (timeout, cursor) => {
      calls.push(timeout);
      if (first) {
        first = false;
        assert.equal(cursor, 7);
        return { after: 9, restarting: true, timed_out: true } as never;
      }
      assert.equal(cursor, 9, "重连要用服务端返回的游标");
      assert.ok(timeout <= 5, "超时按剩余时间递减");
      return { after: 12 } as never;
    },
    restarting: (r) => r.restarting === true,
    nextCursor: (r) => r.after,
    resume: (cursor) => `atrium wait c1 --after ${cursor}`,
  });
  assert.equal(ok.after, 12);
  assert.equal(calls.length, 2);
  // b) 断连（503）→ 重连成功
  let attempt = 0;
  const ok2 = await reconnectingWait<{ after: number }>({
    seconds: 5,
    request: async () => {
      attempt += 1;
      if (attempt === 1)
        throw new Problem(503, "连接被拒绝", "service_unavailable");
      return { after: 3 };
    },
    restarting: () => false,
    resume: () => "atrium wait c1 --after 1",
  });
  assert.equal(ok2.after, 3);
  assert.equal(attempt, 2);
  // c) 一直不回来 → 503 + 可执行的续等命令
  await assert.rejects(
    () =>
      reconnectingWait<{ after: number }>({
        seconds: 1,
        cursor: 5,
        request: async () => {
          throw new Problem(503, "连接被拒绝", "service_unavailable");
        },
        restarting: () => false,
        resume: (cursor) => `atrium wait c1 --after ${cursor}`,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Problem);
      assert.equal(error.code, "service_unavailable");
      assert.equal(error.statusCode, 503);
      assert.equal(error.nextCommand, "atrium wait c1 --after 5");
      return true;
    },
  );
  // d) 非断连错误原样抛出
  await assert.rejects(
    () =>
      reconnectingWait<{ after: number }>({
        seconds: 5,
        request: async () => {
          throw new Problem(400, "参数错了", "usage");
        },
        restarting: () => false,
        resume: () => "atrium wait c1",
      }),
    (error: unknown) => error instanceof Problem && error.code === "usage",
  );
});

const fakeAcp = fileURLToPath(
  new URL("./fixtures/fake-acp-exit.mjs", import.meta.url),
);
const harnessPath = fileURLToPath(
  new URL("./fixtures/idle-wait-harness.ts", import.meta.url),
);

type AppHandle = Awaited<ReturnType<typeof createApp>>;
type Runtimes = NonNullable<AppHandle["runtimes"]>;
type RuntimeConnection =
  Runtimes["connections"] extends Map<string, infer T> ? T : never;

async function bootIdle(data: string) {
  const previous = process.env.ATRIUM_PI_ACP_ENTRY;
  process.env.ATRIUM_PI_ACP_ENTRY = fakeAcp;
  try {
    const created = await createApp({
      auth: false,
      data,
      desktops: join(data, "desktops"),
      piHome: join(data, "pi"),
    });
    const timer = (
      created.runtimes as unknown as {
        interval?: ReturnType<typeof setInterval>;
      } | null
    )?.interval;
    if (timer) clearInterval(timer);
    return created;
  } finally {
    if (previous === undefined) delete process.env.ATRIUM_PI_ACP_ENTRY;
    else process.env.ATRIUM_PI_ACP_ENTRY = previous;
  }
}

function attachRuntime(
  runtimes: Runtimes,
  agentId: string,
  cwd: string,
  busy: boolean,
) {
  const entry: RuntimeConnection = {
    connection: null as unknown as RuntimeConnection["connection"],
    info: {
      runtimeId: agentId,
      generation: agentId,
      sessionId: agentId,
      pid: process.pid,
      ownerPid: null,
      sessionFile: null,
      cwd,
      mode: "rpc",
      busy,
      model: "test",
    },
  };
  runtimes.connections.set(agentId, entry);
  return entry;
}

function insertRunEnd(
  data: string,
  agentId: string,
  at: number,
  runtimeId: string,
  generation = "gap-generation",
) {
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=3000");
    db.prepare(
      `INSERT INTO trace_actions(agent_id,runtime_id,generation,session_id,seq,at,kind,name,title,state,input,output,truncated)
       VALUES(?,?,?,?,1,?,'run_end','','本轮运行结束','complete','','',0)`,
    ).run(agentId, runtimeId, generation, `session-${runtimeId}`, at);
  } finally {
    db.close();
  }
}

function countRunEnds(data: string, agentId: string) {
  const db = new DatabaseSync(join(data, "atrium.sqlite"), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=3000");
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM trace_actions WHERE agent_id=? AND kind='run_end'",
      )
      .get(agentId) as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

async function listenOn(app: AppHandle["app"], port = 0) {
  await app.listen({ host: "127.0.0.1", port });
  const actual = (app.server.address() as { port: number }).port;
  return {
    port: actual,
    origin: `http://127.0.0.1:${actual}`,
  };
}

async function stopApp(created: AppHandle) {
  created.app.server.closeAllConnections();
  await created.app.close();
}

function trackIdle(
  origin: string,
  data: string,
  agentId: string,
  seconds = 20,
) {
  writeFileSync(userTokenPath(data), "a".repeat(64));
  const api = client(origin, data);
  let busySince: number | undefined;
  const urls: string[] = [];
  const headersSeen: Array<number | undefined> = [];
  const pending = reconnectingWait<{
    status: string;
    finished_at: number | null;
    timed_out: boolean;
    restarting?: boolean;
  }>({
    seconds,
    request: (timeout) => {
      const path = `/agents/${agentId}/wait?${agentWaitQuery(timeout, busySince)}`;
      urls.push(path);
      return api.get(path, (headers) => {
        const seen = readBusySince(headers);
        headersSeen.push(seen);
        if (seen !== undefined) busySince = seen;
      });
    },
    restarting: (result) => result.restarting === true,
    resume: () => "atrium wait a1 --idle",
  });
  return { pending, urls, headersSeen, busySince: () => busySince };
}

async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(50);
  }
  assert.fail(label);
}

async function wake(origin: string, chatId: string) {
  const response = await fetch(`${origin}/api/chats/${chatId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned: true }),
  });
  assert.equal(response.status, 200, "唤醒等待失败");
}

test("开始就空闲：不报旧的结束时刻，响应头也没有忙碌起点", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-idle-already-"));
  const created = await bootIdle(data);
  t.after(async () => {
    await stopApp(created).catch(() => undefined);
    rmSync(data, { recursive: true, force: true });
  });
  const agent = created.store.createAgent("空闲验收", data).agent;
  attachRuntime(created.runtimes!, agent.id, data, false);
  const oldAt = Date.now() - 60_000;
  insertRunEnd(data, agent.id, oldAt, "old-runtime");
  const { origin } = await listenOn(created.app);
  const started = Date.now();
  const response = await fetch(
    `${origin}/api/agents/${agent.id}/wait?timeout=5`,
  );
  const body = (await response.json()) as {
    status: string;
    finished_at: number | null;
  };
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-atrium-busy-since"), null);
  assert.equal(body.status, "idle");
  assert.equal(body.finished_at, null, "以前的 run_end 不是这一轮");
  assert.ok(Date.now() - started < 3000, "空闲时应马上返回");
  const bad = await fetch(
    `${origin}/api/agents/${agent.id}/wait?timeout=5&busy_since=1.2`,
  );
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /busy_since/);
});

test("不带 busy_since：仍只认当前连接的 run_end，别的代际再新也不算", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-idle-legacy-"));
  const created = await bootIdle(data);
  t.after(async () => {
    await stopApp(created).catch(() => undefined);
    rmSync(data, { recursive: true, force: true });
  });
  const agent = created.store.createAgent("空闲验收", data).agent;
  const chat = created.store.createChat("唤醒", [agent.id], agent.id);
  const entry = attachRuntime(created.runtimes!, agent.id, data, true);
  insertRunEnd(data, agent.id, 1000, agent.id, agent.id);
  const future = Date.now() + 120_000;
  insertRunEnd(data, agent.id, future, "other-runtime");
  const { origin } = await listenOn(created.app);
  const pending = fetch(
    `${origin}/api/agents/${agent.id}/wait?timeout=10`,
  ).then((response) => response.json()) as Promise<{
    finished_at: number | null;
    status: string;
  }>;
  await until(() => created.pendingWaits() === 1, "等待没有挂上");
  const header = await fetch(
    `${origin}/api/agents/${agent.id}/wait?timeout=10`,
  );
  assert.match(header.headers.get("x-atrium-busy-since") ?? "", /^\d+$/);
  await header.body?.cancel();
  entry.info.busy = false;
  await wake(origin, chat.id);
  const body = await pending;
  assert.equal(body.status, "idle");
  assert.notEqual(body.finished_at, 1000, "起点之前的 run_end 不能当这一轮");
  assert.notEqual(body.finished_at, future, "没带 busy_since 不能拿别的代际");
  assert.ok(
    typeof body.finished_at === "number" && body.finished_at < future - 60_000,
  );
});

test("busy_since 只取起点之后的最新 run_end，对不上就用判定空闲的当前时间", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-idle-since-"));
  const created = await bootIdle(data);
  t.after(async () => {
    await stopApp(created).catch(() => undefined);
    rmSync(data, { recursive: true, force: true });
  });
  const agent = created.store.createAgent("空闲验收", data).agent;
  attachRuntime(created.runtimes!, agent.id, data, false);
  const oldAt = Date.now() - 60_000;
  insertRunEnd(data, agent.id, oldAt, "old-runtime");
  const { origin } = await listenOn(created.app);
  const since = Date.now();
  const missed = (await fetch(
    `${origin}/api/agents/${agent.id}/wait?timeout=5&busy_since=${since}`,
  ).then((response) => response.json())) as { finished_at: number | null };
  assert.notEqual(missed.finished_at, oldAt);
  assert.ok(
    typeof missed.finished_at === "number" && missed.finished_at >= since,
    "库里没有起点之后的 run_end 时，用判定空闲的当前时间",
  );
  const runAt = Date.now() + 120_000;
  insertRunEnd(data, agent.id, runAt, "other-runtime");
  const found = (await fetch(
    `${origin}/api/agents/${agent.id}/wait?timeout=5&busy_since=${since}`,
  ).then((response) => response.json())) as {
    status: string;
    finished_at: number | null;
  };
  assert.equal(found.status, "idle");
  assert.equal(found.finished_at, runAt, "不限 runtime_id，取起点之后最新一条");
});

test("崩溃换进程：开始时在忙，间隙结束后 finished_at 等于补上的 run_end", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-idle-crash-proc-"));
  const apps: AppHandle[] = [];
  t.after(async () => {
    for (const created of apps) await stopApp(created).catch(() => undefined);
    rmSync(data, { recursive: true, force: true });
  });
  const first = await bootIdle(data);
  apps.push(first);
  const agent = first.store.createAgent("空闲验收", data).agent;
  attachRuntime(first.runtimes!, agent.id, data, true);
  const { origin, port } = await listenOn(first.app);
  const started = Date.now();
  const tracked = trackIdle(origin, data, agent.id);
  await until(
    () => tracked.busySince() !== undefined,
    "忙碌起点没有写进响应头",
  );
  const busySince = tracked.busySince()!;
  assert.ok(busySince >= started);
  await stopApp(first);
  assert.equal(
    countRunEnds(data, agent.id),
    0,
    "进程死掉后、新服务起来前，间隙里的 run_end 没有被补记",
  );
  const runAt = busySince + 120_000;
  insertRunEnd(data, agent.id, runAt, "gap-runtime");
  const second = await bootIdle(data);
  apps.push(second);
  attachRuntime(second.runtimes!, agent.id, data, false);
  await listenOn(second.app, port);
  const result = await tracked.pending;
  assert.equal(result.status, "idle");
  assert.equal(result.timed_out, false);
  assert.equal(result.finished_at, runAt);
  assert.ok(result.finished_at >= started);
  assert.doesNotMatch(tracked.urls[0]!, /busy_since/);
  assert.match(tracked.urls.at(-1)!, new RegExp(`busy_since=${busySince}`));
});

test("崩溃换进程：间隙里没有 run_end 时，用新服务判定空闲的当前时间", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-idle-crash-fallback-"));
  const apps: AppHandle[] = [];
  t.after(async () => {
    for (const created of apps) await stopApp(created).catch(() => undefined);
    rmSync(data, { recursive: true, force: true });
  });
  const first = await bootIdle(data);
  apps.push(first);
  const agent = first.store.createAgent("空闲验收", data).agent;
  attachRuntime(first.runtimes!, agent.id, data, true);
  const { origin, port } = await listenOn(first.app);
  const tracked = trackIdle(origin, data, agent.id);
  await until(() => tracked.busySince() !== undefined, "没有忙碌起点");
  const busySince = tracked.busySince()!;
  await stopApp(first);
  assert.equal(countRunEnds(data, agent.id), 0);
  const second = await bootIdle(data);
  apps.push(second);
  attachRuntime(second.runtimes!, agent.id, data, false);
  const marked = Date.now();
  await listenOn(second.app, port);
  const result = await tracked.pending;
  assert.equal(countRunEnds(data, agent.id), 0, "新进程自己不补 run_end");
  assert.equal(result.status, "idle");
  assert.equal(result.timed_out, false);
  assert.equal(typeof result.finished_at, "number");
  assert.ok(result.finished_at! >= busySince);
  assert.ok(result.finished_at! >= marked - 1000);
  assert.ok(result.finished_at! <= Date.now());
});

test("崩溃重连时这一轮还在忙：继续等，结束后报的是这一轮的 run_end", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-idle-still-busy-"));
  const apps: AppHandle[] = [];
  t.after(async () => {
    for (const created of apps) await stopApp(created).catch(() => undefined);
    rmSync(data, { recursive: true, force: true });
  });
  const first = await bootIdle(data);
  apps.push(first);
  const agent = first.store.createAgent("空闲验收", data).agent;
  const chat = first.store.createChat("唤醒", [agent.id], agent.id);
  attachRuntime(first.runtimes!, agent.id, data, true);
  const { origin, port } = await listenOn(first.app);
  let settled = false;
  const tracked = trackIdle(origin, data, agent.id);
  const done = tracked.pending.then((result) => {
    settled = true;
    return result;
  });
  await until(() => tracked.busySince() !== undefined, "没有忙碌起点");
  await stopApp(first);
  const second = await bootIdle(data);
  apps.push(second);
  const entry = attachRuntime(second.runtimes!, agent.id, data, true);
  await listenOn(second.app, port);
  await until(
    () => tracked.headersSeen.length >= 2 && second.pendingWaits() === 1,
    "重连后没有继续挂着等",
  );
  await delay(200);
  assert.equal(settled, false, "重连时还在忙，不能提前返回");
  assert.equal(tracked.headersSeen[1], tracked.headersSeen[0]);
  const runAt = tracked.busySince()! + 120_000;
  insertRunEnd(data, agent.id, runAt, "gap-runtime");
  entry.info.busy = false;
  await wake(`http://127.0.0.1:${port}`, chat.id);
  const result = await done;
  assert.equal(result.status, "idle");
  assert.equal(result.timed_out, false);
  assert.equal(result.finished_at, runAt);
});

test("没接上且中途没忙过：重连不带 busy_since，接上后也不编造结束时刻", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-idle-unbound-header-"));
  const created = await bootIdle(data);
  const pi = spawn("sleep", ["60"]);
  t.after(async () => {
    pi.kill("SIGKILL");
    await stopApp(created).catch(() => undefined);
    rmSync(data, { recursive: true, force: true });
  });
  const agent = created.store.createAgent("未接上身份", data).agent;
  const chat = created.store.createChat("唤醒", [agent.id], agent.id);
  created.store.run(
    "UPDATE agents SET runtime_pid=? WHERE id=?",
    pi.pid!,
    agent.id,
  );
  const { origin } = await listenOn(created.app);
  let settled = false;
  const tracked = trackIdle(origin, data, agent.id);
  const done = tracked.pending.then((result) => {
    settled = true;
    return result;
  });
  await until(() => created.pendingWaits() === 1, "等待没有挂上");
  await delay(200);
  assert.equal(settled, false, "没接上之前不能报空闲");
  assert.deepEqual(tracked.headersSeen, [undefined]);
  created.app.server.closeAllConnections();
  await until(() => tracked.urls.length >= 2, "断开后没有重连");
  assert.ok(
    tracked.urls.every((url) => !url.includes("busy_since")),
    `重连不该带 busy_since：${tracked.urls.join(" ")}`,
  );
  assert.ok(tracked.headersSeen.every((value) => value === undefined));
  attachRuntime(created.runtimes!, agent.id, data, false);
  await wake(origin, chat.id);
  const result = await done;
  assert.equal(result.status, "idle");
  assert.equal(result.timed_out, false);
  assert.equal(result.finished_at, null);
});

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

function spawnHarness(
  data: string,
  port: number,
  mode: string,
  status: string,
  oldEnd = false,
) {
  let stderr = "";
  const child = spawn(process.execPath, ["--import", "tsx", harnessPath], {
    cwd: packageRoot,
    env: childEnv({
      ATRIUM_DATA: data,
      ATRIUM_PORT: String(port),
      ATRIUM_PI_HOME: join(data, "pi"),
      ATRIUM_DESKTOPS: join(data, "desktops"),
      PI_ACP_DIR: join(data, "acp"),
      ATRIUM_PI_ACP_ENTRY: fakeAcp,
      HARNESS_PORT: String(port),
      HARNESS_MODE: mode,
      HARNESS_STATUS: status,
      ...(oldEnd ? { HARNESS_OLD_END: "1" } : {}),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return { child, stderr: () => stderr };
}

async function harnessRows(status: string, label: string, seen?: Set<number>) {
  let last = "";
  for (let i = 0; i < 200; i++) {
    try {
      last = readFileSync(status, "utf8");
    } catch {
      last = "";
    }
    const rows: Array<Record<string, unknown>> = [];
    for (const line of last.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* 读到半行就等下一次 */
      }
    }
    const failed = rows.find((row) => typeof row.error === "string");
    if (failed) throw new Error(`${String(failed.error)}\n${label}`);
    const ready = rows.find(
      (row) => row.ready === true && !seen?.has(Number(row.pid)),
    );
    if (ready) {
      seen?.add(Number(ready.pid));
      return rows;
    }
    await delay(50);
  }
  throw new Error(`${label}：${last}`);
}
