import { test } from "node:test";
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
import { createServer, request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/store.ts";
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
import { openWeb } from "../server/service.ts";

const exec = promisify(execFile);
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "atrium-service-"));
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ATRIUM_DATA: data,
    ATRIUM_PORT: String(port),
    ATRIUM_DESKTOPS: join(root, "desktops"),
    ATRIUM_PI_HOME: join(root, ".pi"),
    ATRIUM_PI_TEMPLATE: builtin,
    PI_ACP_DIR: join(root, "acp"),
  };
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
  t.after(async () => {
    await cli("stop");
    const record = readService(data);
    // Only this fixture's service record, never the user's default instance.
    if (record && record.pid !== process.pid && alive(record.pid))
      process.kill(record.pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });
  const userHeaders = () => ({
    authorization: `Bearer ${readFileSync(userTokenPath(data), "utf8").trim()}`,
  });
  return { root, data, port, env, cli, userHeaders };
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
          env: { ...process.env, ATRIUM_DATA: data },
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
    ["list", "--json"],
    ["auth", "rotate", "--json"],
    ["open", "--json"],
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
  "CLI 从任意目录启动 Web、并发复用、保持数据并可重复停止",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    assert.match((await f.cli("status")).stdout, /未运行/);
    assert(!existsSync(f.data));
    assert.equal((await f.cli("typo")).code, 2);
    assert(!existsSync(f.data));
    const starts = await Promise.all([
      f.cli("--no-open"),
      f.cli("--no-open"),
      f.cli("--no-open"),
    ]);
    for (const result of starts) assert.equal(result.code, 0, result.stderr);
    const record = readService(f.data)!;
    for (const result of starts)
      assert(result.stdout.includes(`PID ${record.pid}`));
    assert.equal(statSync(join(f.data, "service.sqlite")).mode & 0o777, 0o600);
    const url = serviceUrl(record);
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Atrium/);
    assert.match((await f.cli("status")).stdout, /PID/);
    // Explicitly different requested port still reuses this data directory's owner.
    f.env.ATRIUM_PORT = String(f.port + 1);
    assert((await f.cli("--no-open")).stdout.includes(url));
    const template = join(f.root, "template");
    mkdirSync(template);
    writeFileSync(join(template, "settings.json"), '{"packages":[]}');
    const response = await fetch(`${url}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", ...f.userHeaders() },
      body: JSON.stringify({ name: "入口验收", template }),
    });
    assert.equal(response.status, 201);
    const { agent } = (await response.json()) as {
      agent: { id: string; cwd: string };
    };
    assert(
      existsSync(join(f.root, "desktops", "入口验收")),
      "创建即分配固定桌面目录",
    );
    assert.match((await f.cli("list")).stdout, /a1\s+入口验收\s+未分配账号/);
    assert.equal((await f.cli("run", "入口验收", "--forbidden")).code, 2);
    assert.equal((await f.cli("stop")).code, 0);
    assert.match((await f.cli("stop")).stdout, /已停止/);
    assert.equal(readService(f.data), null);
    assert(existsSync(join(f.data, "atrium.sqlite")));
    assert.equal((await f.cli("--no-open")).code, 0);
    const restarted = readService(f.data)!;
    assert.notEqual(restarted.instance, record.instance);
    const overview = (await (
      await fetch(`${serviceUrl(restarted)}/api/overview`, {
        headers: f.userHeaders(),
      })
    ).json()) as { agents: { id: string }[] };
    assert.equal(overview.agents[0]?.id, agent.id);
  },
);

test(
  "CLI 登录、外部推送地址轮换与用户令牌恢复走真实后台服务",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.cli("create", "通知测试")).code, 0);
    const link = await f.cli("open", "--print");
    assert.equal(link.code, 0, link.stderr);
    assert.match(
      link.stdout.trim(),
      /^http:\/\/atrium\.localhost:\d+\/auth\/claim\/[a-f0-9]{64}$/,
    );
    const claimed = await fetch(link.stdout.trim(), { redirect: "manual" });
    assert.equal(claimed.status, 302);
    const cookie = claimed.headers.get("set-cookie")!;
    const record = readService(f.data)!;
    assert.equal(
      (
        await fetch(`${serviceUrl(record)}/api/overview`, {
          headers: { cookie },
        })
      ).status,
      200,
    );
    assert.equal((await f.cli("stop")).code, 0);
    assert.equal((await f.cli("--no-open")).code, 0);
    const restarted = readService(f.data)!;
    assert.equal(
      (
        await fetch(`${serviceUrl(restarted)}/api/overview`, {
          headers: { cookie },
        })
      ).status,
      200,
      "a valid browser session survives the controlled service restart",
    );
    const first = await f.cli("adapters", "url", "通知测试");
    assert.equal(first.code, 0, first.stderr);
    assert.match(
      first.stdout.trim(),
      /^http:\/\/atrium\.localhost:\d+\/hooks\/[^/]+\/[a-f0-9]{64}$/,
    );
    const post = (address: string) =>
      fetch(address, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "仅可写消息箱",
      });
    assert.equal((await post(first.stdout.trim())).status, 200);
    const second = await f.cli("adapters", "url", "通知测试", "--rotate");
    assert.equal(second.code, 0, second.stderr);
    assert.notEqual(first.stdout, second.stdout);
    assert.equal((await post(first.stdout.trim())).status, 404);
    assert.equal((await post(second.stdout.trim())).status, 200);
    assert.equal(
      (await f.cli("adapters", "url", "通知测试", "--revoke")).code,
      0,
    );
    assert.equal((await post(second.stdout.trim())).status, 404);
    const rotated = await f.cli("auth", "rotate");
    assert.equal(rotated.code, 0, rotated.stderr);
    assert.equal(
      (
        await fetch(`${serviceUrl(record)}/api/overview`, {
          headers: { cookie },
        })
      ).status,
      401,
    );
    assert.equal(
      (await f.cli("list")).code,
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
    const missing = await f.cli("list", "--json");
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
    assert.equal((await f.cli("list")).code, 0);
  },
);

test(
  "十个旧身份不阻塞服务监听；按需启动前仍保持旧目录以待迁移",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    mkdirSync(f.data);
    const store = new Store(join(f.data, "atrium.sqlite"));
    const directories: string[] = [];
    for (let index = 0; index < 10; index++) {
      const directory = join(f.root, `legacy-${index}`);
      directories.push(directory);
      mkdirSync(directory);
      writeFileSync(
        join(directory, "settings.json"),
        JSON.stringify({ packages: [] }),
      );
      const { agent } = store.createAgent(`旧身份${index}`, f.root);
      store.run(
        "UPDATE agents SET agent_directory=? WHERE id=?",
        directory,
        agent.id,
      );
    }
    store.close();
    const started = Date.now();
    const result = await f.cli("--no-open");
    const elapsed = Date.now() - started;
    assert.equal(result.code, 0, result.stderr);
    assert(elapsed < 12000, `命令启动耗时 ${elapsed}ms，超出 12 秒上限`);
    const record = readService(f.data)!;
    assert.equal(
      (
        await fetch(`${serviceUrl(record)}/api/overview`, {
          headers: f.userHeaders(),
        })
      ).status,
      200,
    );
    for (const directory of directories)
      assert.equal(existsSync(join(directory, ".atrium-packages.json")), false);
  },
);

test(
  "默认命令在非交互环境只打印登录链接；浏览器失败不丢失已启动服务",
  { timeout: 45000, skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    const opener = join(
      bin,
      process.platform === "darwin" ? "open" : "xdg-open",
    );
    const opened = join(f.root, "opened");
    writeFileSync(opener, `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`, {
      mode: 0o700,
    });
    f.env.PATH = `${bin}:${process.env.PATH}`;
    const start = await f.cli();
    assert.equal(start.code, 0, start.stderr);
    // 非交互（管道 stdio）不调用浏览器，改为打印一次性登录链接。
    assert.match(start.stdout, /非交互环境，没有打开浏览器/);
    assert.match(
      start.stdout,
      /登录链接：http:\/\/atrium\.localhost:\d+\/auth\/claim\/[a-f0-9]{64}/,
    );
    assert.ok(!existsSync(opened), "非 TTY 不应调用 openWeb");
    // 浏览器打开失败只打提示，已启动的服务不受影响。
    writeFileSync(opener, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const record = readService(f.data)!;
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      await openWeb(record);
    } finally {
      console.error = originalError;
      process.env.PATH = previousPath;
    }
    assert.match(
      errors.join("\n"),
      /无法自动打开浏览器；服务已就绪，请手动打开/,
    );
    const afterFailure = await f.cli();
    assert.equal(afterFailure.code, 0);
    assert.match(afterFailure.stdout, /非交互环境，没有打开浏览器/);
    assert.match((await f.cli("status")).stdout, /PID/);
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
    for (const path of [
      "/api/service/stop",
      "/api/service/prepare-restart",
      "/api/service/probe",
      "/api/service/wake",
    ])
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
      assert.equal(result.code, 1, result.stdout);
      assert.match(result.stderr, /启动失败/);
      assert.equal(
        await (await fetch(`http://127.0.0.1:${f.port}`)).text(),
        "not-atrium",
      );
      assert.equal(readService(f.data), null);
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
    t.after(async () => {
      if (child.exitCode === null) child.kill();
    });
    for (let n = 0; n < 100; n++) {
      const record = readService(f.data);
      if (record) {
        try {
          if ((await fetch(`${serviceUrl(record)}/api/overview`)).ok) break;
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
  "CLI create 无需先开 Web；服务运行时走 API 并可 fork",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const created = await f.cli("create", "林岚");
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /林岚/);
    assert(
      existsSync(join(f.root, "desktops", "林岚")),
      "创建即分配固定桌面目录",
    );
    assert(
      existsSync(join(f.root, ".pi", "agents", "林岚")),
      "名称入口指向身份配置",
    );
    assert.equal((await f.cli("create", "林岚")).code, 4);
    assert.equal((await f.cli("create", "bad/name")).code, 2);
    assert.match((await f.cli("list")).stdout, /a1\s+林岚\s+未分配账号/);
    assert.equal((await f.cli("--no-open")).code, 0, "start after create");
    const forked = await f.cli("create", "沈默", "--from", "林岚");
    assert.equal(forked.code, 0, forked.stderr);
    assert.match(forked.stdout, /沈默/);
    const overview = (await (
      await fetch(`${serviceUrl(readService(f.data)!)}/api/overview`, {
        headers: f.userHeaders(),
      })
    ).json()) as { agents: { ref: string; name: string }[] };
    assert.deepEqual(
      overview.agents.map((a) => [a.ref, a.name]),
      [
        ["a1", "林岚"],
        ["a2", "沈默"],
      ],
    );
  },
);

test(
  "排空完成后再次 prepare-restart 返回唤醒名单；stopping 中 CLI 给出明确下一步（#231）",
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
    const listed = await f.cli("list");
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
    const listed = await f.cli("list");
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
