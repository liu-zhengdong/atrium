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
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/store.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { setTimeout as delay } from "node:timers/promises";
import {
  alive,
  packageRoot,
  readService,
  serviceUrl,
} from "../server/service-state.ts";

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
    unlinkSync(userTokenPath(f.data));
    const missing = await f.cli("list");
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /atrium auth rotate/);
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
  "默认命令调用浏览器；浏览器失败不丢失已启动服务",
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
    assert.match(
      readFileSync(opened, "utf8"),
      /^http:\/\/atrium\.localhost:\d+\/auth\/claim\/[a-f0-9]{64}$/,
    );
    writeFileSync(opener, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const failedOpen = await f.cli();
    assert.equal(failedOpen.code, 0);
    assert.match(failedOpen.stderr, /无法自动打开浏览器；服务已就绪/);
    assert.match((await f.cli("status")).stdout, /PID/);
  },
);

test(
  "停止需要服务凭据及正确来源；不按陈旧 PID 杀进程；崩溃后并发重启",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.cli("--no-open")).code, 0);
    const record = readService(f.data)!;
    const url = serviceUrl(record);
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
