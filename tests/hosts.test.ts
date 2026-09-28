import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SshConnection } from "../server/hosts/tunnel-plan.ts";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import { Agent } from "../server/agent/main.ts";
import { killTree, processAlive } from "../server/platform/index.ts";
import { fixture, until } from "./task-fixture.ts";
import { nodeCommand } from "./portable-shell.ts";
import { QuotaReaders } from "../server/quota-readers/index.ts";

/**
 * 远程执行者（#358 第 1 步）：真 HTTP 服务 + 同机起的代理（数据目录分开），假执行者。
 * 覆盖接入、派到 h2、日志续传、退出上报、服务重启后代理重连补报、令牌边界。
 */

type Fx = ReturnType<typeof fixture>;
type After = { after: (fn: () => void | Promise<void>) => void };

async function serve(
  fx: Fx,
  data: string,
  port = 0,
  extra: {
    agentOnlineMs?: number;
    agentCheckWatchMs?: number;
    tunnelSpawn?: (connection: SshConnection) => ChildProcess;
    tunnelStop?: (child: ChildProcess) => void;
  } = {},
) {
  const created = await createApp({
    data,
    auth: false,
    quotaReaders: null,
    tasks: {
      env: fx.env,
      workersDir: fx.workers,
      exec: fx.run,
      tickMs: 100,
      killGraceMs: 200,
      pace: async () => undefined,
      usagePace: async () => undefined,
      agentPollMs: 500,
      agentPickupMs: 1500,
      ...extra,
    },
  });
  await created.app.listen({ port, host: "127.0.0.1" });
  const address = created.app.server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  const call = async (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
  ) => {
    const response = await created.app.inject({
      method,
      url,
      headers: { host: "127.0.0.1" },
      ...(payload ? { payload } : {}),
    });
    return { status: response.statusCode, body: response.json() };
  };
  // 与 main.ts 关服务一样断开剩余连接：同进程里停下的代理会在连接池里留下半开的连接。
  const close = async () => {
    const closing = created.app.close();
    created.app.server.closeAllConnections();
    await closing;
  };
  return { ...created, port: actual, call, close };
}

function startAgent(
  t: After,
  input: {
    port: number;
    data: string;
    env: NodeJS.ProcessEnv;
    code?: string;
    fetch?: typeof fetch;
    quota?: QuotaReaders | null;
  },
) {
  const lines: string[] = [];
  const agent = new Agent({
    server: `http://127.0.0.1:${input.port}`,
    data: input.data,
    // 代理按整机负载报「这台太忙」：测试机负载不能让指定 h2 的活排队。
    env: { ...input.env, ATRIUM_BUSY_LOAD: "off", ATRIUM_MAX_WORKERS: "off" },
    code: input.code,
    version: "test",
    tickMs: 100,
    log: (line) => lines.push(line),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.quota !== undefined ? { quota: input.quota } : {}),
  });
  const done = agent.start().catch((error: unknown) => {
    lines.push(`启动失败：${String(error)}`);
  });
  t.after(async () => {
    agent.stop();
    await done;
  });
  return { agent, lines, done };
}

const hostOf = async (
  call: Awaited<ReturnType<typeof serve>>["call"],
  ref: string,
) =>
  (await call("GET", `/api/hosts/${ref}`)).body as {
    connection: string;
    running: number;
    info: { data_dir: string; clis: Record<string, unknown> } | null;
  };

test("主机 API：SSH 连接随 hN 保存，编辑后重启隧道，列表和详情给出状态", async (t) => {
  const fx = fixture(t);
  const spawned: {
    connection: SshConnection;
    child: EventEmitter & { stderr: PassThrough; pid: number };
  }[] = [];
  const stopped: ChildProcess[] = [];
  const server = await serve(fx, join(fx.root, "ssh-data"), 0, {
    tunnelSpawn: (connection) => {
      const child = Object.assign(new EventEmitter(), {
        stderr: new PassThrough(),
        pid: 101,
      });
      spawned.push({ connection, child });
      return child as unknown as ChildProcess;
    },
    tunnelStop: (child) => stopped.push(child),
  });
  let closed = false;
  t.after(() => (closed ? undefined : server.close()));
  const added = await server.call("POST", "/api/hosts", {
    name: "ggb",
    ssh: "cpcli@100.70.239.117",
    tunnel: "4310:14310",
    key: "~/.ssh/id_ed25519",
  });
  assert.equal(added.status, 200);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.connection.remotePort, 14310);
  spawned[0]!.child.emit("spawn");
  const shown = await server.call("GET", "/api/hosts/h2");
  assert.equal(shown.body.ssh.status, "运行中");
  assert.equal(shown.body.ssh.agentServer, "http://127.0.0.1:14310");
  const edited = await server.call("PATCH", "/api/hosts/h2", {
    tunnel: "4310:14311",
  });
  assert.equal(edited.status, 200);
  assert.equal(spawned.length, 2);
  assert.equal(stopped.length, 1);
  assert.equal(
    (await server.call("GET", "/api/hosts")).body.hosts[1].ssh.tunnel,
    "4310:14311",
  );
  assert.equal(
    (await server.call("PATCH", "/api/hosts/h1", { ssh: "u@host" })).status,
    409,
  );
  assert.equal(
    (
      await server.call("POST", "/api/hosts", {
        name: "bad",
        ssh: "-oBad",
        tunnel: "4310:14310",
      })
    ).status,
    400,
  );
  await server.close();
  closed = true;
  assert.equal(stopped.length, 2);
});

test("远程主机：接入、派到 h2、日志与结果传回本机；令牌只管代理接口", async (t) => {
  const fx = fixture(t);
  // 远程上的假 opencode：打一行后稍等再给结果，便于看到日志续传。
  fx.script(
    "opencode",
    'echo \'{"type":"step_start","part":{}}\'\necho remote-hello\nsleep 0.3\necho \'{"type":"text","part":{"text":"远程完成"}}\'',
  );
  const data = join(fx.root, "data");
  const server = await serve(fx, data);
  t.after(() => server.close());
  const { call, port } = server;
  const hosts = (await call("GET", "/api/hosts")).body.hosts;
  assert.deepEqual(
    hosts.map((h: { ref: string; kind: string }) => [h.ref, h.kind]),
    [["h1", "local"]],
  );
  const added = await call("POST", "/api/hosts", {
    name: "虚拟机",
    repos: ["*"],
  });
  assert.equal(added.status, 200);
  assert.equal(added.body.host.ref, "h2");
  assert.equal(added.body.host.connection, "pending");
  const code: string = added.body.code;
  assert.match(code, /^h2-[a-f0-9]{64}$/);

  // 错的接入码、不带接入码：认证在读请求体之前就拒。
  const wrong = await fetch(`http://127.0.0.1:${port}/api/agent/join`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer h2-${"0".repeat(64)}`,
    },
    body: "{}",
  });
  assert.equal(wrong.status, 401);

  const agentData = join(fx.root, "agent");
  const { lines } = startAgent(t, {
    port,
    data: agentData,
    env: fx.env,
    code,
  });
  await until(() => lines.some((line) => line.includes("已连上")), 10_000);
  const h2 = await hostOf(call, "h2");
  assert.equal(h2.connection, "online");
  assert.equal(h2.info?.data_dir, agentData);
  assert.ok(h2.info?.clis.opencode);
  // 令牌只在代理数据目录里，0600。
  const config = JSON.parse(
    readFileSync(join(agentData, "agent.json"), "utf8"),
  );
  assert.equal(config.host, "h2");
  if (process.platform !== "win32")
    assert.equal(statSync(join(agentData, "agent.json")).mode & 0o777, 0o600);
  // 接入码只能用一次。
  const reused = await fetch(`http://127.0.0.1:${port}/api/agent/join`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${code}`,
    },
    body: "{}",
  });
  assert.equal(reused.status, 401);
  // 主机令牌碰不到用户接口；代理接口不认用户那一套。
  const bearer = { authorization: `Bearer ${config.token}` };
  const secured = await createApp({
    data: join(fx.root, "secured"),
    tasks: { pace: async () => undefined, env: fx.env },
  });
  t.after(() => secured.app.close());
  assert.equal(
    (
      await secured.app.inject({
        url: "/api/tasks",
        headers: { host: "127.0.0.1", ...bearer },
      })
    ).statusCode,
    401,
  );
  // 代理接口不看 Host（代理经转发连进来），用户接口仍只面向本机。
  assert.equal(
    (
      await server.app.inject({
        method: "POST",
        url: "/api/agent/log",
        headers: { host: "host.orb.internal:4310", ...bearer },
        payload: { task: 99, run: 1, offset: 0, data: "" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await server.app.inject({
        url: "/api/tasks",
        headers: { host: "host.orb.internal:4310" },
      })
    ).statusCode,
    403,
  );

  assert.equal(
    (
      await call("POST", "/api/tasks", {
        title: "远程做个调查",
        deliver: "none",
      })
    ).status,
    201,
  );
  const run = await call("POST", "/api/tasks/t1/run", {
    worker: "opencode",
    host: "h2",
  });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.task.host_ref, "h2");
  assert.equal(run.body.task.status, "running");
  const waited = await call("GET", "/api/tasks/t1/wait?timeout=20");
  const task = waited.body.task;
  assert.equal(task.status, "done", JSON.stringify(task.events.slice(-3)));
  assert.equal(task.host_ref, "h2");
  assert.match(task.result, /远程完成/);
  // 日志传回本机任务目录，task log 照旧读得到；远程那份也在代理数据目录里。
  const log = await call("GET", "/api/tasks/t1/log");
  assert.match(log.body.text, /remote-hello/);
  assert.match(log.body.text, /\[atrium\] t1 · opencode/);
  assert.ok(existsSync(join(agentData, "tasks", "1", "log")));
  assert.ok(existsSync(join(agentData, "tasks", "1", "prompt.md")));
  const started = task.events.find((e: { kind: string }) => e.kind === "start");
  assert.equal(JSON.parse(started.detail).detail.host, "h2");
  // 代理报完结果就删掉运行记录。
  await until(() => !existsSync(join(agentData, "runs", "1.json")));

  // 指定不存在或离线的主机：拒绝并说清原因。
  await call("POST", "/api/tasks", { title: "第二件", deliver: "none" });
  const refused = await call("POST", "/api/tasks/t2/run", {
    worker: "opencode",
    host: "h9",
  });
  assert.equal(refused.status, 404);
  const bad = await call("POST", "/api/tasks/t2/run", { host: "2" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /host: 应为主机短号/);

  // 暂停：指定它也派不过去；移除后代理因令牌失效停下。
  assert.equal(
    (await call("POST", "/api/hosts/h2/pause", { paused: true })).status,
    200,
  );
  const paused = await call("POST", "/api/tasks/t2/run", {
    worker: "opencode",
    host: "h2",
  });
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /h2 已暂停接活/);
  assert.equal(
    (await call("POST", "/api/hosts/h1/pause", { paused: false })).status,
    200,
  );
  assert.equal((await call("DELETE", "/api/hosts/h1")).status, 409);
  assert.equal((await call("DELETE", "/api/hosts/h2")).status, 200);
  await until(
    () => lines.some((line) => line.includes("服务不认这台主机的令牌")),
    10_000,
  );
  const listed = (await call("GET", "/api/hosts?all=1")).body.hosts;
  assert.deepEqual(
    listed.map((h: { ref: string; removed: boolean }) => [h.ref, h.removed]),
    [
      ["h1", false],
      ["h2", true],
    ],
  );
});

test("远程主机：有仓库的活在代理机器上克隆、建工作树，事实在那台上查", async (t) => {
  const fx = fixture(t);
  writeFileSync(
    join(fx.workers, "harness", "kimi.md"),
    "---\nchecks: [local_check, claims_verified]\n---\n",
  );
  const server = await serve(fx, join(fx.root, "data"));
  t.after(() => server.close());
  const { call, port } = server;
  const { code } = (
    await call("POST", "/api/hosts", { name: "远程", repos: ["*"] })
  ).body;
  const agentData = join(fx.root, "agent");
  const { lines } = startAgent(t, { port, data: agentData, env: fx.env, code });
  await until(() => lines.some((line) => line.includes("已连上")), 10_000);
  await call("POST", "/api/tasks", { title: "Remote change", repo: fx.repo });
  const run = await call("POST", "/api/tasks/t1/run", {
    worker: "kimi",
    host: "h2",
  });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  // 工作树在代理数据目录里，不在本机仓库旁边。
  assert.ok(run.body.task.worktree.startsWith(join(agentData, "repos")));
  assert.equal(existsSync(`${fx.repo}-t1-remote-change`), false);
  const task = (await call("GET", "/api/tasks/t1/wait?timeout=30")).body.task;
  const gates = JSON.parse(
    task.events.find((e: { kind: string }) => e.kind === "gates").detail,
  );
  // 改动规模经代理在那台的工作树里查到；全量检查留给合入队列，交付时不跑。
  assert.deepEqual(gates.diff, { files: 1, added: 1, removed: 0 });
  assert.equal(
    task.events.some((e: { kind: string }) => e.kind.startsWith("local_check")),
    false,
  );
  assert.equal(task.status, "done", JSON.stringify(gates));
  // 执行者环境是代理机器上的白名单环境。
  const seen = readFileSync(join(agentData, "repos", "env-seen.txt"), "utf8");
  assert.match(seen, /ATRIUM_WORKER=1/);
  assert.doesNotMatch(seen, /HERDR_PANE|CLAUDECODE/);
});

test("远程主机：服务重启与断线期间执行者照跑，重连后补传日志与结果", async (t) => {
  const fx = fixture(t);
  const marker = join(fx.root, "release");
  // 等到 marker 出现才结束：服务停着的时候结束，结果只能靠重连后补报。
  fx.script(
    "opencode",
    `echo '{"type":"step_start","part":{}}'\necho before-restart\nwhile [ ! -f "${marker.replace(/\\/g, "/")}" ]; do sleep 0.1; done\necho after-restart\necho '{"type":"text","part":{"text":"断线后补报"}}'`,
  );
  const data = join(fx.root, "data");
  let server = await serve(fx, data);
  const firstServer = server;
  t.after(() => firstServer.close());
  const port = server.port;
  const { code } = (
    await server.call("POST", "/api/hosts", { name: "远程", repos: ["*"] })
  ).body;
  const { lines } = startAgent(t, {
    port,
    data: join(fx.root, "agent"),
    env: fx.env,
    code,
  });
  await until(() => lines.some((line) => line.includes("已连上")), 10_000);
  await server.call("POST", "/api/tasks", { title: "长活", deliver: "none" });
  assert.equal(
    (
      await server.call("POST", "/api/tasks/t1/run", {
        worker: "opencode",
        host: "h2",
      })
    ).status,
    200,
  );
  await until(
    () =>
      readFileSync(join(data, "tasks", "1", "log"), "utf8").includes(
        "before-restart",
      ),
    10_000,
  );
  // 服务停下（等同断网）：执行者在代理那台接着跑，这期间结束。
  await server.close();
  await until(
    () => lines.some((line) => /与服务断开|连不上服务/.test(line)),
    10_000,
  );
  writeFileSync(marker, "");
  await until(() => lines.some((line) => line.includes("t1 已退出")), 10_000);
  // 同一数据目录、同一端口起新服务：接管 h2 上的这一轮，代理重连后补传日志并报结果。
  server = await serve(fx, data, port);
  t.after(() => server.close());
  const task = (await server.call("GET", "/api/tasks/t1/wait?timeout=30")).body
    .task;
  assert.equal(task.status, "done", JSON.stringify(task.events.slice(-4)));
  assert.match(task.result, /断线后补报/);
  assert.ok(task.events.some((e: { kind: string }) => e.kind === "adopted"));
  const log = (await server.call("GET", "/api/tasks/t1/log")).body.text;
  assert.match(log, /before-restart[\s\S]*after-restart/);
  assert.ok(lines.some((line) => line.includes("t1 的结果已上报")));
});

test("远程主机：离线时停下任务先在账本收尾，代理重启后接着看进程、按对账结束账本不认的", async (t) => {
  const fx = fixture(t);
  fx.script("opencode", 'echo \'{"type":"step_start","part":{}}\'\nsleep 60');
  const data = join(fx.root, "data");
  const agentData = join(fx.root, "agent");
  let server = await serve(fx, data);
  const firstServer = server;
  t.after(() => firstServer.close());
  const port = server.port;
  const { code } = (
    await server.call("POST", "/api/hosts", { name: "远程", repos: ["*"] })
  ).body;
  const first = startAgent(t, { port, data: agentData, env: fx.env, code });
  await until(
    () => first.lines.some((line) => line.includes("已连上")),
    10_000,
  );
  await server.call("POST", "/api/tasks", { title: "要停的", deliver: "none" });
  const run = await server.call("POST", "/api/tasks/t1/run", {
    worker: "opencode",
    host: "h2",
  });
  assert.equal(run.status, 200);
  const pid: number = run.body.task.pid;
  // 代理停下（执行者不随它退出）。刚停时 h2 还算在线：派过去的活没人来领，很快报错而不是干等。
  first.agent.stop();
  await first.done;
  await server.call("POST", "/api/tasks", { title: "没人领", deliver: "none" });
  const unclaimed = await server.call("POST", "/api/tasks/t2/run", {
    worker: "kimi",
    host: "h2",
  });
  assert.equal(unclaimed.status, 409, JSON.stringify(unclaimed.body));
  assert.match(unclaimed.body.error, /h2 的代理 2 秒内没来领/);
  // 服务重启后 h2 离线。
  await server.close();
  server = await serve(fx, data, port);
  t.after(() => server.close());
  server.db.prepare("UPDATE hosts SET last_seen_at=0 WHERE id=2").run();
  assert.equal(
    (await server.call("GET", "/api/hosts/h2")).body.connection,
    "offline",
  );
  const stop = await server.call("POST", "/api/tasks/t1/stop");
  assert.equal(stop.status, 200);
  const task = (await server.call("GET", "/api/tasks/t1/wait?timeout=20")).body
    .task;
  assert.notEqual(task.status, "running");
  process.kill(pid, 0);
  // 代理重启：按运行记录接着看那个进程；重连后服务不认这一轮，代理结束它。
  const second = startAgent(t, { port, data: agentData, env: fx.env });
  await until(
    () => second.lines.some((line) => line.includes("接着看 t1")),
    10_000,
  );
  await until(
    () => second.lines.some((line) => line.includes("服务已不认 t1")),
    20_000,
  );
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 20_000);
  // 那个进程结束后代理照样补报（服务说不认），然后删掉运行记录。
  await until(
    () => !existsSync(join(agentData, "runs", "1.json")),
    20_000,
  ).catch((error: Error) => {
    throw new Error(`${error.message}；代理日志：\n${second.lines.join("\n")}`);
  });
});

test("远程主机：代理停下后执行者才结束，停下的代理不再写运行记录", async (t) => {
  const fx = fixture(t);
  fx.script("opencode", 'echo \'{"type":"step_start","part":{}}\'\nsleep 60');
  const server = await serve(fx, join(fx.root, "data"));
  t.after(() => server.close());
  const agentData = join(fx.root, "agent");
  const { code } = (
    await server.call("POST", "/api/hosts", { name: "远程", repos: ["*"] })
  ).body;
  const first = startAgent(t, {
    port: server.port,
    data: agentData,
    env: fx.env,
    code,
  });
  await until(
    () => first.lines.some((line) => line.includes("已连上")),
    10_000,
  );
  await server.call("POST", "/api/tasks", { title: "要停的", deliver: "none" });
  const run = await server.call("POST", "/api/tasks/t1/run", {
    worker: "opencode",
    host: "h2",
  });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const pid: number = run.body.task.pid;
  first.agent.stop();
  await first.done;
  const file = join(agentData, "runs", "1.json");
  const before = readFileSync(file, "utf8");
  // 停下的代理实例还握着子进程，照样收到退出事件；记录已归下一个代理，它不能再写。
  // 否则下一个代理补报、删掉记录后又被写回来（Windows 上 pid 看到进程没了可能早于退出事件）。
  killTree(pid, "SIGKILL");
  await until(() => !processAlive(pid), 10_000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(JSON.parse(before).exit, undefined);
  assert.ok(!first.lines.some((line) => line.includes("t1 已退出")));
});

test("远程主机：拉起回执晚到时，执行者已经结束也照样补传日志与结果", async (t) => {
  const fx = fixture(t);
  fx.script("opencode", 'echo \'{"type":"text","part":{"text":"瞬间完成"}}\'');
  const server = await serve(fx, join(fx.root, "data"));
  t.after(() => server.close());
  const { code } = (
    await server.call("POST", "/api/hosts", { name: "远程", repos: ["*"] })
  ).body;
  // 回执晚 0.6 秒送到：这期间执行者已结束，代理不能先传日志、被服务当成不认的一轮。
  const slow: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/api/agent/reply"))
      await new Promise((resolve) => setTimeout(resolve, 600));
    return fetch(url, init);
  };
  const { lines } = startAgent(t, {
    port: server.port,
    data: join(fx.root, "agent"),
    env: fx.env,
    code,
    fetch: slow,
  });
  await until(() => lines.some((line) => line.includes("已连上")), 10_000);
  await server.call("POST", "/api/tasks", { title: "快活", deliver: "none" });
  const run = await server.call("POST", "/api/tasks/t1/run", {
    worker: "opencode",
    host: "h2",
  });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const task = (await server.call("GET", "/api/tasks/t1/wait?timeout=20")).body
    .task;
  assert.equal(task.status, "done", JSON.stringify(task.events.slice(-3)));
  assert.match(task.result, /瞬间完成/);
});

/**
 * 本机任务的检查派到远程（#358 第 2 步）用的仓库：检查脚本写出工作目录与交付文件，
 * 在代理的检查工作树（路径带 -check-）里多睡 sleepMs，便于在检查进行中看状态、断网。
 * 假 kimi 等 marker 出现才提交（不推送），测试在这之前把本机暂停接活，检查就只能派到 h2。
 */
function checkRepo(fx: Fx, sleepMs: number) {
  // 这个文件在时远程多睡 10 秒（断网太久的场景）。
  const slow = join(fx.root, "slow").replace(/\\/g, "/");
  mkdirSync(join(fx.repo, ".agents"));
  writeFileSync(
    join(fx.repo, ".agents", "check"),
    nodeCommand(
      [
        "const fs = require('fs')",
        "const remote = process.cwd().includes('-check-')",
        "console.log('checked-in:' + process.cwd())",
        "console.log('delivered:' + (fs.existsSync('done.txt') ? fs.readFileSync('done.txt', 'utf8').trim() : 'missing'))",
        `setTimeout(() => { console.log('check-finished'); process.exit(0) }, remote ? (fs.existsSync('${slow}') ? 10000 : ${sleepMs}) : 0)`,
      ].join("; "),
    ),
  );
  execFileSync("git", ["-C", fx.repo, "add", ".agents/check"]);
  execFileSync("git", [
    "-C",
    fx.repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@e",
    "commit",
    "-qm",
    "check",
  ]);
  execFileSync("git", ["-C", fx.repo, "push", "-q", "origin", "main"]);
  writeFileSync(
    join(fx.workers, "harness", "kimi.md"),
    "---\nchecks: [claims_verified]\n---\n",
  );
  const marker = join(fx.root, "deliver");
  fx.script(
    "kimi",
    `set -e\nwhile [ ! -f "${marker.replace(/\\/g, "/")}" ]; do sleep 0.1; done\necho hi > done.txt\ngit add done.txt\ngit commit -qm done\necho "完成，提交 $(git rev-parse --short HEAD)"`,
  );
  return { marker, slow };
}

/** 反复查到条件成立：每次等上一趟请求回来再发下一趟（服务关了就不再发）。 */
async function eventually(check: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待超时");
}

/**
 * 合入队列重跑检查用的派发（#358 第 2 步）：交付关卡不再跑全量检查，测试直接调它，
 * 记下开始在哪台跑、换过哪台。
 */
function dispatchCheck(
  server: Awaited<ReturnType<typeof serve>>,
  fx: Fx,
  data: string,
  task: number,
  worktree: string,
) {
  const started: { host: string; log: string }[] = [];
  const moved: { from: string; reason: string }[] = [];
  const result = server.taskRunner.checks.run({
    task,
    worktree,
    taskDir: join(data, "tasks", String(task)),
    base: "main",
    env: fx.env,
    onStatus: (status, log, host) => {
      if (status === "started") started.push({ host, log });
    },
    onMoved: (from, reason) => moved.push({ from, reason }),
  });
  return { result, started, moved };
}

/** 本机暂停接活后放假 kimi 交付：检查只能派到远程。 */
async function deliverWithLocalPaused(
  call: Awaited<ReturnType<typeof serve>>["call"],
  marker: string,
) {
  const paused = await call("POST", "/api/hosts/h1/pause", { paused: true });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  writeFileSync(marker, "");
}

test("远程检查：本机任务交付后，检查带着没推送的提交派到 h2 跑完，结果与日志回到本机", async (t) => {
  const fx = fixture(t);
  const { marker } = checkRepo(fx, 1500);
  const data = join(fx.root, "data");
  const server = await serve(fx, data);
  t.after(() => server.close());
  const { call, port } = server;
  const { code } = (
    await call("POST", "/api/hosts", { name: "远程", repos: ["*"] })
  ).body;
  const agentData = join(fx.root, "agent");
  const { lines } = startAgent(t, { port, data: agentData, env: fx.env, code });
  await until(() => lines.some((line) => line.includes("已连上")), 10_000);
  await call("POST", "/api/tasks", { title: "Local change", repo: fx.repo });
  const run = await call("POST", "/api/tasks/t1/run", { worker: "kimi" });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.task.host ?? null, null);
  const worktree: string = run.body.task.worktree;
  await deliverWithLocalPaused(call, marker);
  const task = (await call("GET", "/api/tasks/t1/wait?timeout=30")).body.task;
  assert.equal(task.status, "done", JSON.stringify(task.events.slice(-4)));
  const dispatched = dispatchCheck(server, fx, data, 1, worktree);
  const check = await dispatched.result;
  assert.equal(check.status, "passed", JSON.stringify(check));
  assert.equal(check.host, "h2");
  // 检查的就是本机工作树里没推送的交付提交。
  const head = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  assert.equal(check.commit, head);
  assert.equal(check.log, join(data, "tasks", "1", "local-check.log"));
  const log = readFileSync(check.log, "utf8");
  assert.match(log, /checked-in:.*-check-0/);
  assert.match(log, /delivered:hi/);
  assert.match(log, /check-finished/);
  assert.equal(dispatched.started[0]?.host, "h2");
  // 代理那边的检查目录跑完即清；检查工作树留着下次沿用。
  await until(
    () =>
      !existsSync(join(agentData, "checks")) ||
      readdirSync(join(agentData, "checks")).length === 0,
    5_000,
  );
});

test("远程检查：进行中断网再恢复，结果与日志补齐；断线太久退回本机重跑，只记一次结果", async (t) => {
  const fx = fixture(t);
  const { marker, slow } = checkRepo(fx, 2500);
  const data = join(fx.root, "data");
  const server = await serve(fx, data, 0, {
    agentOnlineMs: 3000,
    agentCheckWatchMs: 200,
  });
  t.after(() => server.close());
  const { call, port } = server;
  const { code } = (
    await call("POST", "/api/hosts", { name: "远程", repos: ["*"] })
  ).body;
  // 断网：代理发出的请求一律失败（进行中的长轮询照旧收尾）。
  let cut = false;
  const flaky: typeof fetch = (input, init) =>
    cut ? Promise.reject(new TypeError("fetch failed")) : fetch(input, init);
  const agentData = join(fx.root, "agent");
  const { lines } = startAgent(t, {
    port,
    data: agentData,
    env: fx.env,
    code,
    fetch: flaky,
  });
  await until(() => lines.some((line) => line.includes("已连上")), 10_000);
  const logFile = (id: number) =>
    join(data, "tasks", String(id), "local-check.log");
  const readLog = (id: number) => {
    try {
      return readFileSync(logFile(id), "utf8");
    } catch {
      return "";
    }
  };

  // 一、短断网（比离线判定短）：检查在 h2 跑完，恢复后日志补齐、结果照常。
  await call("POST", "/api/tasks", { title: "Short cut", repo: fx.repo });
  const first = await call("POST", "/api/tasks/t1/run", { worker: "kimi" });
  assert.equal(first.status, 200);
  await deliverWithLocalPaused(call, marker);
  let task = (await call("GET", "/api/tasks/t1/wait?timeout=30")).body.task;
  assert.equal(task.status, "done");
  let dispatched = dispatchCheck(server, fx, data, 1, first.body.task.worktree);
  await until(() => readLog(1).includes("checked-in:"), 20_000);
  cut = true;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  cut = false;
  let check = await dispatched.result;
  assert.equal(check.host, "h2", JSON.stringify(check));
  assert.equal(check.status, "passed");
  assert.match(readLog(1), /checked-in:[\s\S]*check-finished/);
  assert.equal(dispatched.moved.length, 0);

  // 二、长断网（超过离线判定）：服务不再等 h2，退回本机重跑；恢复后 h2 晚到的结果不算。
  // 等代理重连上（断网时它在退避重试）。
  await until(
    () => lines.filter((line) => line.includes("已连上")).length >= 2,
    15_000,
  );
  rmSync(marker, { force: true });
  writeFileSync(slow, "");
  // 本机恢复接活，t2 才在本机跑；交付前再暂停，检查才派到 h2。
  await call("POST", "/api/hosts/h1/pause", { paused: false });
  await call("POST", "/api/tasks", { title: "Long cut", repo: fx.repo });
  const second = await call("POST", "/api/tasks/t2/run", { worker: "kimi" });
  assert.equal(second.status, 200);
  await deliverWithLocalPaused(call, marker);
  task = (await call("GET", "/api/tasks/t2/wait?timeout=30")).body.task;
  assert.equal(task.status, "done");
  dispatched = dispatchCheck(server, fx, data, 2, second.body.task.worktree);
  await until(() => readLog(2).includes("checked-in:"), 20_000);
  cut = true;
  check = await dispatched.result;
  cut = false;
  assert.equal(check.host, "h1", JSON.stringify(check));
  assert.equal(check.status, "passed");
  assert.equal(dispatched.moved.length, 1);
  const [moved] = dispatched.moved;
  assert.equal(moved!.from, "h2");
  assert.match(moved!.reason, /离线/);
  // 本机重跑的日志：本机工作树，不是 h2 的检查工作树。
  assert.doesNotMatch(readLog(2), /-check-/);
  // 恢复后代理重连，服务在长轮询的回答里叫停这次检查（远程还要睡 10 秒，叫停在那之前）；
  // 目录清掉，账本里仍只有一次结果。
  await until(
    () => lines.some((line) => line.includes("服务已不再等一次检查")),
    8_000,
  );
  assert.ok(!lines.some((line) => line.includes("t2 的检查结束：passed")));
  await until(
    () =>
      !existsSync(join(agentData, "checks")) ||
      readdirSync(join(agentData, "checks")).length === 0,
    15_000,
  );
});

test("远程检查：没有在线的远程主机时照旧在本机跑", async (t) => {
  const fx = fixture(t);
  const { marker } = checkRepo(fx, 0);
  const data = join(fx.root, "data");
  const server = await serve(fx, data, 0, { agentOnlineMs: 1000 });
  t.after(() => server.close());
  const { call, port } = server;
  const { code } = (
    await call("POST", "/api/hosts", { name: "远程", repos: ["*"] })
  ).body;
  const { agent, lines, done } = startAgent(t, {
    port,
    data: join(fx.root, "agent"),
    env: fx.env,
    code,
  });
  await until(() => lines.some((line) => line.includes("已连上")), 10_000);
  agent.stop();
  await done;
  await eventually(
    async () =>
      (await call("GET", "/api/hosts/h2")).body.connection === "offline",
  );
  await call("POST", "/api/tasks", { title: "Offline", repo: fx.repo });
  const run = await call("POST", "/api/tasks/t1/run", { worker: "kimi" });
  assert.equal(run.status, 200);
  await deliverWithLocalPaused(call, marker);
  const task = (await call("GET", "/api/tasks/t1/wait?timeout=30")).body.task;
  assert.equal(task.status, "done");
  const dispatched = dispatchCheck(server, fx, data, 1, run.body.task.worktree);
  const check = await dispatched.result;
  assert.equal(check.host, "h1", JSON.stringify(check));
  assert.equal(check.status, "passed");
  assert.equal(dispatched.moved.length, 0);
});

test("额度多主机合并：代理上报读数与账号指纹，atrium quota 合并后给出读自哪台与 CLI 在哪几台可用", async (t) => {
  const fx = fixture(t);
  const data = join(fx.root, "data");
  const server = await serve(fx, data);
  t.after(() => server.close());
  const { call, port } = server;
  const { code } = (
    await call("POST", "/api/hosts", { name: "远程", repos: ["*"] })
  ).body;
  const now = Date.now();
  const token = "sk-secret-token-should-not-leave";
  const readers = new QuotaReaders(
    {
      platform: "linux",
      home: fx.root,
      env: {},
      readFile: async () => undefined,
      keychain: async () => undefined,
      fetch,
      now: () => now,
      timeoutMs: 1000,
    },
    [
      {
        provider: "opencode",
        read: async () => ({
          ok: true,
          plan: "Go",
          windows: [
            {
              id: "weekly",
              label: "Weekly",
              usedPercent: 42,
              resetsAt: now + 3600_000,
              periodSeconds: 604800,
            },
          ],
          refreshedAt: now,
          account: "0123456789abcdef",
        }),
      },
      {
        provider: "codex",
        read: async () => ({ ok: false, reason: "没有找到 Codex 登录" }),
      },
    ],
  );
  const { lines } = startAgent(t, {
    port,
    data: join(fx.root, "agent"),
    env: fx.env,
    code,
    quota: readers,
  });
  await until(() => lines.some((line) => line.includes("已连上")), 10_000);
  let accounts: {
    providerId: string;
    from?: string | null;
    hosts?: string[];
    note: string | null;
    usedPercent: number | null;
  }[] = [];
  await eventually(async () => {
    accounts = (await call("GET", "/api/quota")).body.accounts;
    return accounts.some((a) => a.providerId === "opencode" && a.from === "h2");
  });
  const opencode = accounts.find((a) => a.providerId === "opencode")!;
  assert.equal(opencode.usedPercent, 42);
  assert.match(opencode.note ?? "", /读自 h2/);
  // 假 opencode、kimi 在两台的 PATH 里都有：本机与 h2 都能用。
  assert.deepEqual(opencode.hosts, ["h1", "h2"]);
  const codex = accounts.find((a) => a.providerId === "codex")!;
  assert.match(codex.note ?? "", /没有找到 Codex 登录/);
  // 只传额度数字与指纹：令牌不出现在服务的任何回答里。
  assert.doesNotMatch(JSON.stringify(accounts), new RegExp(token));
  // 破坏输入：读数里夹带多余字段或非法指纹会被拒收。
  const hostToken = JSON.parse(
    readFileSync(join(fx.root, "agent", "agent.json"), "utf8"),
  ).token as string;
  const bad = await fetch(`http://127.0.0.1:${port}/api/agent/quota`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${hostToken}`,
    },
    body: JSON.stringify({
      readings: [
        {
          provider: "opencode",
          outcome: {
            ok: true,
            result: {
              ok: true,
              plan: null,
              windows: [],
              refreshedAt: now,
              account: token,
            },
            note: null,
          },
        },
      ],
    }),
  });
  assert.equal(bad.status, 400);
  const anonymous = await fetch(`http://127.0.0.1:${port}/api/agent/quota`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ readings: [] }),
  });
  assert.equal(anonymous.status, 401);
});
