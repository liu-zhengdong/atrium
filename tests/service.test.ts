import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent, createServer, request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { userTokenPath } from "../server/user-auth.ts";
import { declaredBodyWithoutBytes } from "./raw-http.ts";
import { setTimeout as delay } from "node:timers/promises";
import {
  alive,
  packageRoot,
  claimService,
  readService,
  serviceUrl,
} from "../server/service-state.ts";
import {
  assertNoFixtureLeaks,
  finishFixture,
  trackChild,
  trackFixture,
} from "./fixture-signal.ts";
import { childEnv } from "./child-env.ts";
import { fixture as workerFixture, until } from "./task-fixture.ts";
import { readRestartState } from "../server/supervisor.ts";

const exec = promisify(execFile);
after(assertNoFixtureLeaks);
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "atrium-service-"));
  const signal = trackFixture(join(root, "data"), root);
  const data = join(root, "data");
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const builtin = join(root, "pi-template");
  mkdirSync(builtin);
  writeFileSync(
    join(builtin, "settings.json"),
    JSON.stringify({ packages: [] }),
  );
  writeFileSync(join(builtin, "SYSTEM.md"), "builtin rules");
  const env: NodeJS.ProcessEnv = childEnv({
    ATRIUM_DATA: data,
    ATRIUM_PORT: String(port),
    ATRIUM_DESKTOPS: join(root, "desktops"),
    ATRIUM_PI_HOME: join(root, ".pi"),
    ATRIUM_PI_TEMPLATE: builtin,
    PI_ACP_DIR: join(root, "acp"),
  });
  const cli = async (...args: string[]) => {
    try {
      const output = await exec(
        process.execPath,
        [join(packageRoot, "bin/atrium.mjs"), ...args],
        { env, cwd: root, timeout: 25000 },
      );
      return { ...output, code: 0 };
    } catch (error) {
      const failure = error as Error & {
        stdout: string;
        stderr: string;
        code: number;
      };
      return {
        stdout: failure.stdout,
        stderr: failure.stderr,
        code: failure.code,
      };
    }
  };
  t.after(() => finishFixture(signal));
  const userHeaders = () => ({
    authorization: `Bearer ${readFileSync(userTokenPath(data), "utf8").trim()}`,
  });
  return { root, data, port, env, cli, userHeaders, signal };
}

test("新 CLI 连接旧服务：提示 restart 和退出码 7，不进入 rotate 自指循环", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-upgrade-gap-"));
  const data = join(root, "data");
  const old = createServer((req, res) => {
    if (req.url === "/api/service") {
      if (req.headers.authorization !== `Bearer ${lease.record.token}`) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          instance: lease.record.instance,
          pid: process.pid,
          version: "0.1.4",
          stopping: false,
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      '{"agents":[{"secret":"old service must not receive new CLI token"}]}',
    );
  });
  await new Promise<void>((resolve) => old.listen(0, "127.0.0.1", resolve));
  const lease = claimService(data, (old.address() as { port: number }).port);
  t.after(async () => {
    await new Promise<void>((resolve) => old.close(() => resolve()));
    lease.release();
    rmSync(root, { recursive: true, force: true });
  });
  const cli = async (...args: string[]) => {
    try {
      const result = await exec(
        process.execPath,
        [join(packageRoot, "bin/atrium.mjs"), ...args],
        {
          cwd: root,
          env: childEnv({ ATRIUM_DATA: data }),
          timeout: 15000,
        },
      );
      return { ...result, code: 0 };
    } catch (error) {
      const failure = error as Error & {
        stdout: string;
        stderr: string;
        code: number;
      };
      return {
        stdout: failure.stdout,
        stderr: failure.stderr,
        code: failure.code,
      };
    }
  };
  for (const args of [
    ["task", "ls", "--json"],
    ["auth", "rotate", "--json"],
  ]) {
    const outcome = await cli(...args);
    assert.equal(outcome.code, 7, `${args.join(" ")}: ${outcome.stderr}`);
    assert.equal(
      JSON.parse(outcome.stdout).error.code,
      "upgrade_restart_required",
    );
    assert.equal(JSON.parse(outcome.stdout).next, "atrium restart");
  }
  assert.equal(existsSync(userTokenPath(data)), false);
  const status = await cli("auth", "status", "--json");
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).result.upgradeRequired, true);
});

test(
  "CLI 从任意目录启动服务、并发复用、保持数据并可重复停止",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    assert.match((await f.cli("status")).stdout, /未运行/);
    assert(!existsSync(f.data));
    assert.equal((await f.cli("typo")).code, 2);
    assert(!existsSync(f.data));
    const starts = await Promise.all([f.cli(), f.cli("--no-open"), f.cli()]);
    for (const result of starts) assert.equal(result.code, 0, result.stderr);
    const record = readService(f.data)!;
    for (const result of starts)
      assert(result.stdout.includes(`PID ${record.pid}`));
    assert.equal(statSync(join(f.data, "service.sqlite")).mode & 0o777, 0o600);
    const url = serviceUrl(record);
    // 没有 Web 外壳：未认证的路径一律 401，不泄露页面。
    assert.equal((await fetch(url)).status, 401);
    assert.match((await f.cli("status")).stdout, /PID/);
    // Explicitly different requested port still reuses this data directory's owner.
    f.env.ATRIUM_PORT = String(f.port + 1);
    assert((await f.cli()).stdout.includes(url));
    const added = await f.cli("task", "add", "入口验收", "--json");
    assert.equal(added.code, 0, added.stderr);
    assert.equal((await f.cli("stop")).code, 0);
    assert.match((await f.cli("stop")).stdout, /已停止/);
    assert.equal(readService(f.data), null);
    assert(existsSync(join(f.data, "atrium.sqlite")));
    assert.equal((await f.cli()).code, 0);
    const restarted = readService(f.data)!;
    assert.notEqual(restarted.instance, record.instance);
    const listed = await f.cli("task", "ls", "--json");
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /入口验收/);
  },
);

test(
  "执行者在跑时随时重启：新服务按 pid 接管，重启后立即续派；遗留的待空闲重启记录被丢弃",
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    const worker = workerFixture(t);
    // 两个一直在跑的假执行者：grok 与 codex 都只 sleep，不输出、不改文件。
    writeFileSync(
      join(worker.workers, "harness", "grok.md"),
      "---\nlimits: {startup_minutes: 10}\n---\n",
    );
    writeFileSync(
      join(worker.workers, "harness", "codex.md"),
      "---\nlimits: {startup_minutes: 10}\n---\n",
    );
    // sleep 要长于整个用例：负载高时重启可能拖过 30 秒，执行者先跑完会让最后的 task stop 返回 409。
    for (const tool of ["grok", "codex"])
      writeFileSync(join(worker.root, "bin", tool), "#!/bin/sh\nsleep 120\n", {
        mode: 0o755,
      });
    f.env.ATRIUM_WORKERS_DIR = worker.workers;
    f.env.PATH = worker.env.PATH;
    f.env.HOME = worker.env.HOME;
    // 旧版 restart --when-idle 留下的记录：启动时丢弃，不再挡派活。
    mkdirSync(f.data, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(f.data, "restart-state.json"),
      JSON.stringify({
        id: "rst-legacy",
        status: "waiting_idle",
        supervisorPid: 0,
        startedAt: Date.now(),
        idleDeadline: Date.now() + 1_800_000,
        fromVersion: "0.1.38",
        data: f.data,
      }),
    );
    assert.equal((await f.cli("--no-open")).code, 0);
    assert.equal(existsSync(join(f.data, "restart-state.json")), false);
    assert.match(
      readFileSync(join(f.data, "service.log"), "utf8"),
      /丢弃旧版待空闲重启记录（rst-legacy，waiting_idle）/,
    );
    const record = readService(f.data)!;
    for (const title of ["long-a", "long-b", "next", "spare"]) {
      const added = await f.cli("task", "add", title, "--repo", worker.repo);
      assert.equal(added.code, 0, added.stderr);
    }
    for (const [ref, tool] of [
      ["t1", "grok"],
      ["t2", "codex"],
    ]) {
      const run = await f.cli("task", "run", ref, "--worker", tool);
      assert.equal(run.code, 0, run.stderr);
      assert.doesNotMatch(run.stdout, /排队/);
    }
    const pids = [1, 2].map((id) => {
      const db = new DatabaseSync(join(f.data, "atrium.sqlite"), {
        readOnly: true,
      });
      try {
        return (
          db.prepare("SELECT pid FROM tasks WHERE id=?").get(id) as {
            pid: number;
          }
        ).pid;
      } finally {
        db.close();
      }
    });
    for (const pid of pids) assert.equal(alive(pid), true);

    // 兼容参数 --when-idle：提示后直接重启；紧接着的 task add 等新服务就绪后自动发出。
    const restarting = await f.cli("restart", "--when-idle");
    assert.equal(restarting.code, 0, restarting.stderr);
    assert.match(restarting.stderr, /不需要等执行者空闲.*--when-idle 不再生效/);
    assert.match(restarting.stdout, /平滑重启已启动/);
    const during = await f.cli("task", "add", "重启期间建的", "--json");
    assert.equal(during.code, 0, during.stderr);
    assert.equal(JSON.parse(during.stdout).result.ref, "t5");
    const waited = await f.cli("restart", "--wait", "--timeout", "60");
    assert.equal(waited.code, 0, waited.stderr);
    assert.equal(readRestartState(f.data)?.status, "success");
    const newer = readService(f.data)!;
    assert.notEqual(newer.instance, record.instance);

    // 执行者不中断，被新服务接管。
    for (const pid of pids) assert.equal(alive(pid), true);
    for (const ref of ["t1", "t2"]) {
      const shown = await f.cli("task", "show", ref, "--json");
      assert.equal(shown.code, 0, shown.stderr);
      const task = JSON.parse(shown.stdout).result as {
        status: string;
        events: { kind: string; detail: string }[];
      };
      assert.equal(task.status, "running");
      assert.match(
        task.events.find((event) => event.kind === "adopted")?.detail ?? "",
        /服务重启后按 pid 接管/,
      );
    }
    // 新任务立即派出，不排队。
    const next = await f.cli("task", "run", "t3", "--worker", "opencode");
    assert.equal(next.code, 0, next.stderr);
    assert.doesNotMatch(next.stdout, /排队|等待重启/);
    const listed = await f.cli("task", "ls");
    assert.doesNotMatch(listed.stdout, /等待重启/);
    for (const ref of ["t1", "t2"])
      assert.equal((await f.cli("task", "stop", ref)).code, 0);
  },
);

test(
  "用户令牌轮换与丢失后恢复走真实后台服务",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.cli()).code, 0);
    const record = readService(f.data)!;
    const before = f.userHeaders();
    assert.equal(
      (await fetch(`${serviceUrl(record)}/api/tasks`, { headers: before }))
        .status,
      200,
    );
    const rotated = await f.cli("auth", "rotate");
    assert.equal(rotated.code, 0, rotated.stderr);
    assert.equal(
      (await fetch(`${serviceUrl(record)}/api/tasks`, { headers: before }))
        .status,
      401,
      "旧令牌轮换后失效",
    );
    assert.equal(
      (await f.cli("task", "ls")).code,
      0,
      "CLI automatically uses the rotated local token",
    );
    const authStatus = await f.cli("auth", "status", "--json");
    assert.equal(authStatus.code, 0, authStatus.stderr);
    assert.deepEqual(JSON.parse(authStatus.stdout).result, {
      user: "u1",
      scope: "local",
      service: serviceUrl(record),
      data: realpathSync(f.data),
      authenticated: true,
    });
    unlinkSync(userTokenPath(f.data));
    const missing = await f.cli("task", "ls", "--json");
    assert.equal(missing.code, 6, missing.stderr);
    assert.equal(JSON.parse(missing.stdout).error.code, "auth_required");
    assert.match(
      JSON.parse(missing.stdout).error.message,
      /atrium auth rotate/,
    );
    assert.equal(
      (await f.cli("auth", "rotate")).code,
      0,
      "service control restores a lost token",
    );
    assert.equal((await f.cli("task", "ls")).code, 0);
  },
);

test(
  "旧运行时留下的表不读不写，也不妨碍启动（#291）",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    mkdirSync(f.data);
    const legacy = new DatabaseSync(join(f.data, "atrium.sqlite"));
    legacy.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE messages(id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE inbox_tokens(agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE, token_hash TEXT NOT NULL);
      CREATE TABLE deliveries(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), kind TEXT NOT NULL, text TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', slot TEXT, error TEXT, created_at INTEGER NOT NULL, chat_id TEXT, through_message INTEGER, accepted_at INTEGER, UNIQUE(agent_id,slot));
      CREATE INDEX deliveries_pending ON deliveries(agent_id,created_at) WHERE state='pending';
      CREATE INDEX deliveries_accepted ON deliveries(agent_id,accepted_at) WHERE state='accepted';`);
    legacy.prepare("INSERT INTO agents VALUES(?,?)").run("legacy-1", "旧身份");
    legacy.prepare("INSERT INTO messages(body) VALUES(?)").run("旧消息");
    legacy
      .prepare(
        "INSERT INTO deliveries(id,agent_id,kind,text,created_at) VALUES(?,?,?,?,?)",
      )
      .run("d1", "legacy-1", "text", "旧交付", 123);
    const oldDeliverySchema = legacy
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='deliveries'",
      )
      .get()?.sql;
    legacy.close();
    const result = await f.cli();
    assert.equal(result.code, 0, result.stderr);
    const record = readService(f.data)!;
    assert.equal(
      (
        await fetch(`${serviceUrl(record)}/api/tasks`, {
          headers: f.userHeaders(),
        })
      ).status,
      200,
    );
    assert.equal((await f.cli("org", "tree")).code, 0);
    writeFileSync(join(f.root, "role.md"), "实现并检查服务功能");
    const addedRole = await f.cli(
      "role",
      "add",
      "服务维护",
      "--description",
      "维护服务",
      "--body",
      join(f.root, "role.md"),
    );
    assert.equal(addedRole.code, 0, addedRole.stderr);
    const addedTask = await f.cli("task", "add", "检查旧库兼容", "--job", "r1");
    assert.equal(addedTask.code, 0, addedTask.stderr);
    assert.equal((await f.cli("role", "show", "r1")).code, 0);
    assert.equal((await f.cli("workers")).code, 0);
    assert.equal((await f.cli("stop")).code, 0);
    const after = new DatabaseSync(join(f.data, "atrium.sqlite"), {
      readOnly: true,
    });
    try {
      assert.deepEqual(
        { ...after.prepare("SELECT id,name FROM agents").get() },
        { id: "legacy-1", name: "旧身份" },
      );
      assert.equal(
        after.prepare("SELECT count(*) AS n FROM messages").get()?.n,
        1,
      );
      assert.equal(
        after
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='deliveries'",
          )
          .get()?.sql,
        oldDeliverySchema,
      );
      assert.deepEqual(
        {
          ...after
            .prepare(
              "SELECT id,agent_id,kind,text,state,created_at FROM deliveries",
            )
            .get()!,
        },
        {
          id: "d1",
          agent_id: "legacy-1",
          kind: "text",
          text: "旧交付",
          state: "pending",
          created_at: 123,
        },
      );
      assert.equal(
        after.prepare("SELECT count(*) AS n FROM task_deliveries").get()?.n,
        0,
      );
      assert.equal(
        after.prepare("SELECT count(*) AS n FROM job_roles").get()?.n,
        1,
      );
      assert.equal(
        after.prepare("SELECT count(*) AS n FROM tasks WHERE job_id=1").get()
          ?.n,
        1,
      );
    } finally {
      after.close();
    }
  },
);

test(
  "停止需要服务凭据及正确来源；不按陈旧 PID 杀进程；崩溃后并发重启",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const started = await f.cli("--no-open");
    assert.equal(started.code, 0, started.stderr || started.stdout);
    const record = readService(f.data)!;
    const url = serviceUrl(record);
    for (const path of ["/api/service/stop", "/api/service/prepare-restart"])
      assert.equal(
        await declaredBodyWithoutBytes(record.port, path),
        401,
        path,
      );
    const deniedHeaders: Record<string, string>[] = [
      {},
      { authorization: "Bearer wrong" },
    ];
    for (const headers of deniedHeaders) {
      assert.equal(
        (await fetch(`${url}/api/service/stop`, { method: "POST", headers }))
          .status,
        401,
      );
    }
    assert.equal(
      (
        await fetch(`${url}/api/service/stop`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${record.token}`,
            origin: "https://untrusted.example",
          },
        })
      ).status,
      403,
    );
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        `${url}/api/service`,
        { headers: { host: "untrusted.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(badHost, 403);
    const db = new DatabaseSync(join(f.data, "service.sqlite"));
    try {
      db.prepare("UPDATE service SET record=? WHERE id=1").run(
        JSON.stringify({ ...record, pid: process.pid, token: "0".repeat(64) }),
      );
      assert.equal((await f.cli("stop")).code, 1);
      assert(alive(record.pid));
      db.prepare("UPDATE service SET record=? WHERE id=1").run(
        JSON.stringify({
          ...record,
          instance: "00000000-0000-4000-8000-000000000000",
        }),
      );
      assert.equal((await f.cli("stop")).code, 1);
      assert(alive(record.pid));
    } finally {
      db.prepare("UPDATE service SET record=? WHERE id=1").run(
        JSON.stringify(record),
      );
      db.close();
    }
    process.kill(record.pid, "SIGKILL");
    for (let n = 0; n < 100 && alive(record.pid); n++) await delay(30);
    assert(!alive(record.pid));
    const results = await Promise.all([f.cli("--no-open"), f.cli("--no-open")]);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    assert.notEqual(readService(f.data)!.instance, record.instance);
  },
);

test(
  "占用端口和非法参数明确失败；前台入口使用相同生命周期",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    f.env.ATRIUM_PORT = "not-a-port";
    assert.equal((await f.cli("--no-open")).code, 1);
    assert(!existsSync(f.data));
    f.env.ATRIUM_PORT = String(f.port);
    const other = createServer((_, reply) => reply.end("not-atrium"));
    await new Promise<void>((resolve) =>
      other.listen(f.port, "127.0.0.1", resolve),
    );
    try {
      const result = await f.cli("--no-open");
      assert.equal(result.code, 4, result.stdout);
      // t71：启动前就查出端口被占，只报一句人话，不拉起服务、不建数据目录。
      assert.match(
        result.stderr,
        new RegExp(`端口 ${f.port} 已被其他程序占用；换端口请设 ATRIUM_PORT`),
      );
      assert.doesNotMatch(result.stderr, /EADDRINUSE|\n\s+at /, "不打印堆栈");
      assert(!existsSync(f.data));
      assert.equal(
        await (await fetch(`http://127.0.0.1:${f.port}`)).text(),
        "not-atrium",
      );
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "server/main.ts"],
      {
        cwd: packageRoot,
        env: f.env,
        stdio: "ignore",
      },
    );
    trackChild(f.signal, child);
    t.after(async () => {
      if (child.exitCode === null) child.kill();
    });
    for (let n = 0; n < 100; n++) {
      const record = readService(f.data);
      if (record) {
        try {
          if (
            (
              await fetch(`${serviceUrl(record)}/api/tasks`, {
                headers: f.userHeaders(),
              })
            ).ok
          )
            break;
        } catch {}
      }
      await delay(50);
    }
    assert.equal(readService(f.data)?.pid, child.pid);
    assert.equal((await f.cli("--no-open")).code, 0);
    assert.equal(readService(f.data)?.pid, child.pid);
    assert.equal((await f.cli("stop")).code, 0);
  },
);

test(
  "SSE、空闲 keep-alive 与 events wait 在重启时断开或返回，新服务可重新连接",
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.cli("--no-open")).code, 0);
    const old = readService(f.data)!;
    const url = serviceUrl(old);
    const headers = f.userHeaders();
    const agent = new Agent({ keepAlive: true });
    t.after(() => agent.destroy());
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(`${url}/api/service/info`, { agent }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(Object.keys(agent.freeSockets).length, 1);

    let stream: ReturnType<typeof httpRequest>;
    const disconnected = new Promise<void>((resolve, reject) => {
      stream = httpRequest(`${url}/api/map/stream`, { headers }, (res) => {
        if (res.statusCode !== 200)
          reject(new Error(`SSE HTTP ${res.statusCode}`));
        res.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("event: hello")) ready();
        });
        res.on("close", resolve);
      });
      stream.on("error", reject);
      stream.end();
    });
    let ready!: () => void;
    const hello = new Promise<void>((resolve) => (ready = resolve));
    t.after(() => stream?.destroy());
    await hello;
    const waiting = fetch(`${url}/api/events/wait?timeout=60`, {
      headers,
    }).then((response) => response.json() as Promise<{ restarting?: boolean }>);
    await delay(200);
    const started = await f.cli("restart");
    assert.equal(started.code, 0, started.stderr);
    const finished = await f.cli("restart", "--wait", "--timeout", "60");
    assert.equal(finished.code, 0, finished.stderr || finished.stdout);
    assert.equal((await waiting).restarting, true);
    await disconnected;
    assert.equal(alive(old.pid), false);
    const next = readService(f.data)!;
    assert.notEqual(next.instance, old.instance);
    assert.equal((await f.cli("status")).code, 0);
    const reconnected = await fetch(`${serviceUrl(next)}/api/map/stream`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(reconnected.status, 200);
    await reconnected.body?.cancel();
  },
);

test(
  "服务从假包目录启动后该目录被替换，仍能平滑重启",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    const fakePackage = join(f.root, "fake-package");
    mkdirSync(fakePackage);
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        join(packageRoot, "server/main.ts"),
      ],
      { cwd: fakePackage, env: f.env, stdio: "ignore" },
    );
    trackChild(f.signal, child);
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    const deadline = Date.now() + 30000;
    let record = readService(f.data);
    while (record?.pid !== child.pid) {
      assert.ok(Date.now() < deadline, "假包目录中的服务启动超时");
      await delay(100);
      record = readService(f.data);
    }
    // 模拟 npm 安装覆盖旧包目录；旧服务仍在运行，原 cwd 已被删除。
    rmSync(fakePackage, { recursive: true });
    assert.equal(existsSync(fakePackage), false);
    const started = await f.cli("restart");
    assert.equal(started.code, 0, started.stderr || started.stdout);
    const finished = await f.cli("restart", "--wait", "--timeout", "60");
    assert.equal(finished.code, 0, finished.stderr || finished.stdout);
    const next = readService(f.data);
    assert.ok(next);
    assert.notEqual(next.pid, child.pid);
    assert.equal(readRestartState(f.data)?.status, "success");
    assert.equal((await f.cli("status")).code, 0);
  },
);

test(
  "两份数据抢同一端口：报出占用者的数据目录，第二份数据不建表（t71）",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const started = await f.cli("--no-open");
    assert.equal(started.code, 0, started.stderr || started.stdout);
    const info = await fetch(`http://127.0.0.1:${f.port}/api/service/info`);
    assert.equal(info.status, 200, "服务信息接口免认证");
    assert.deepEqual(
      { ...((await info.json()) as object), version: undefined },
      { service: "atrium", data: realpathSync(f.data), version: undefined },
    );
    const second = join(f.root, "second");
    const expected = `端口 ${f.port} 已被另一份数据的 Atrium 占用：数据在 ${realpathSync(f.data)}；要用它请设 ATRIUM_DATA=${realpathSync(f.data)}`;
    const env = { ...f.env, ATRIUM_DATA: second };
    // 命令行：启动前就查出来，不拉起服务。
    const viaCli = await exec(
      process.execPath,
      [join(packageRoot, "bin/atrium.mjs"), "--no-open"],
      { env, cwd: f.root, timeout: 25000 },
    ).then(
      () => ({ code: 0, stderr: "" }),
      (error: { code: number; stderr: string }) => error,
    );
    assert.equal(viaCli.code, 4, "端口冲突按 conflict 退出");
    assert(viaCli.stderr.includes(expected), viaCli.stderr);
    assert.doesNotMatch(viaCli.stderr, /EADDRINUSE|\n\s+at /);
    assert(!existsSync(second), "命令行不建第二份数据目录");
    // 经服务的命令（task ls）：同一句回执，不附第二份数据的日志与 status 修正。
    const viaCommand = await exec(
      process.execPath,
      [join(packageRoot, "bin/atrium.mjs"), "task", "ls"],
      { env, cwd: f.root, timeout: 25000 },
    ).then(
      () => ({ code: 0, stderr: "" }),
      (error: { code: number; stderr: string }) => error,
    );
    assert.equal(viaCommand.code, 4);
    assert(viaCommand.stderr.includes(expected), viaCommand.stderr);
    assert.doesNotMatch(viaCommand.stderr, /日志：|atrium status/);
    assert(!existsSync(second));
    // 服务入口直接启动（绕过命令行）：同样在建表前退出。
    const viaServer = await exec(
      process.execPath,
      ["--import", "tsx", join(packageRoot, "server/main.ts")],
      { env, cwd: packageRoot, timeout: 25000 },
    ).then(
      () => ({ code: 0, stderr: "" }),
      (error: { code: number; stderr: string }) => error,
    );
    assert.equal(viaServer.code, 1);
    assert(viaServer.stderr.includes(expected), viaServer.stderr);
    assert.doesNotMatch(viaServer.stderr, /EADDRINUSE|\n\s+at /);
    assert(!existsSync(second), "服务入口也在登记与建表之前退出");
    assert.equal((await f.cli("status")).code, 0, "原服务不受影响");
  },
);

test(
  "排空完成后再次 prepare-restart 仍返回就绪；stopping 中 CLI 给出明确下一步（#231）",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const started = await f.cli("--no-open");
    assert.equal(started.code, 0, started.stderr || started.stdout);
    const record = readService(f.data)!;
    const url = serviceUrl(record);
    const headers = {
      authorization: `Bearer ${record.token}`,
      "content-type": "application/json",
    };
    const drain = await fetch(`${url}/api/service/prepare-restart`, {
      method: "POST",
      headers,
      body: JSON.stringify({ timeout: 5000 }),
    });
    assert.equal(drain.status, 200);
    const drained = (await drain.json()) as {
      ready: boolean;
      agentsToWake: string[];
    };
    assert.equal(drained.ready, true);
    // 接替的 supervisor 续做升级：拿到 200 与同一份名单，而不是 409（场景 2）
    const again = await fetch(`${url}/api/service/prepare-restart`, {
      method: "POST",
      headers,
      body: JSON.stringify({ timeout: 5000 }),
    });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), drained);
    // 新版 CLI 遇到 stopping 的旧服务：给出明确的下一步（场景 3）
    const listed = await f.cli("task", "ls");
    assert.notEqual(listed.code, 0);
    assert.match(`${listed.stdout}\n${listed.stderr}`, /平滑重启或关闭中/);
    assert.match(`${listed.stdout}\n${listed.stderr}`, /restart --wait/);
  },
);

test(
  "排空完成后 supervisor 失联且超过上限：旧服务自动恢复；supervisor 仍在时不抢先恢复（#244）",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    f.env.ATRIUM_DRAIN_RECOVER_MS = "1500";
    const started = await f.cli("--no-open");
    assert.equal(started.code, 0, started.stderr || started.stdout);
    const record = readService(f.data)!;
    const url = serviceUrl(record);
    const headers = {
      authorization: `Bearer ${record.token}`,
      "content-type": "application/json",
    };
    const stopping = async () =>
      (
        (await (await fetch(`${url}/api/service`, { headers })).json()) as {
          stopping: boolean;
        }
      ).stopping;
    // 充当 supervisor 的独立进程，模拟 restart 拉起后被 kill -9。
    const supervisor = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    t.after(() => {
      if (supervisor.exitCode == null) supervisor.kill("SIGKILL");
    });
    const supervisorPid = supervisor.pid!;
    writeFileSync(
      join(f.data, "restart-state.json"),
      JSON.stringify({
        id: "rst-244",
        status: "stopping",
        supervisorPid,
        startedAt: Date.now(),
        fromVersion: "0.0.0",
        data: f.data,
        oldPid: record.pid,
      }),
    );
    const drain = await fetch(`${url}/api/service/prepare-restart`, {
      method: "POST",
      headers,
      body: JSON.stringify({ timeout: 5000, supervisorPid }),
    });
    assert.equal(drain.status, 200);
    assert.equal(await stopping(), true);
    // 超过上限但 supervisor 还在：继续等它发 stop，不能自己恢复成第二个写者。
    await delay(3500);
    assert.equal(await stopping(), true);
    assert.equal(
      (await fetch(`${url}/api/service/health`, { headers })).status,
      503,
    );
    supervisor.kill("SIGKILL");
    await new Promise((resolve) => supervisor.once("exit", resolve));
    let recovered = false;
    for (let n = 0; n < 100 && !recovered; n++) {
      await delay(100);
      recovered = !(await stopping());
    }
    assert.equal(recovered, true, "supervisor 失联后旧服务应恢复运行");
    const health = await fetch(`${url}/api/service/health`, { headers });
    assert.equal(health.status, 200);
    assert.equal(readService(f.data)!.pid, record.pid);
    const log = readFileSync(join(f.data, "service.log"), "utf8");
    assert.match(log, /平滑重启未完成：排空完成后 1\.5 秒内没有收到停止请求/);
    assert.match(log, new RegExp(`supervisor（PID ${supervisorPid}）已不在`));
    const state = JSON.parse(
      readFileSync(join(f.data, "restart-state.json"), "utf8"),
    ) as { status: string; error: string };
    assert.equal(state.status, "failed");
    assert.match(state.error, /已自动恢复运行.*atrium restart/);
    const listed = await f.cli("task", "ls");
    assert.equal(listed.code, 0, listed.stderr || listed.stdout);

    // 恢复后可以再次平滑重启；收到 stop 后不再恢复，正常退出。
    const again = await fetch(`${url}/api/service/prepare-restart`, {
      method: "POST",
      headers,
      body: JSON.stringify({ timeout: 5000, supervisorPid: process.pid }),
    });
    assert.equal(again.status, 200);
    const stopped = await fetch(`${url}/api/service/stop`, {
      method: "POST",
      headers: { authorization: headers.authorization },
    });
    assert.equal(stopped.status, 200);
    for (let n = 0; n < 100 && alive(record.pid); n++) await delay(100);
    assert(!alive(record.pid));
    assert.equal(
      readFileSync(join(f.data, "service.log"), "utf8").match(/平滑重启未完成/g)
        ?.length,
      1,
    );
  },
);
