import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import { Agent } from "../server/agent/main.ts";
import { fixture, until } from "./task-fixture.ts";
import { nodeCommand } from "./portable-shell.ts";

/**
 * 远程执行者（#358 第 1 步）：真 HTTP 服务 + 同机起的代理（数据目录分开），假执行者。
 * 覆盖接入、派到 h2、日志续传、退出上报、服务重启后代理重连补报、令牌边界。
 */

type Fx = ReturnType<typeof fixture>;
type After = { after: (fn: () => void | Promise<void>) => void };

async function serve(fx: Fx, data: string, port = 0) {
  const created = await createApp({
    data,
    auth: false,
    tasks: {
      env: fx.env,
      workersDir: fx.workers,
      exec: fx.run,
      tickMs: 100,
      killGraceMs: 200,
      pace: async () => undefined,
      usagePace: async () => undefined,
      diskFreeGb: async () => 1000,
      agentPollMs: 500,
      agentPickupMs: 1500,
    },
  });
  await created.app.listen({ port, host: "127.0.0.1" });
  const address = created.app.server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  const call = async (
    method: "GET" | "POST" | "DELETE",
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

test("远程主机：有仓库的活在代理机器上克隆、建工作树，事实与本地检查在那台上查", async (t) => {
  const fx = fixture(t);
  mkdirSync(join(fx.repo, ".agents"));
  writeFileSync(
    join(fx.repo, ".agents", "check"),
    nodeCommand(
      "console.log('remote-checked-' + process.cwd()); process.exit(0)",
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
  // 改动规模经代理在那台的工作树里查到；本地检查在那台上跑、工作目录是远程工作树。
  assert.deepEqual(gates.diff, { files: 1, added: 1, removed: 0 });
  const local = JSON.parse(
    task.events.find((e: { kind: string }) => e.kind === "local_check").detail,
  );
  assert.equal(local.status, "passed", JSON.stringify(local));
  assert.match(local.log, /^h2:/);
  assert.match(
    readFileSync(join(agentData, "tasks", "1", "local-check.log"), "utf8"),
    /remote-checked-.*repos/,
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
