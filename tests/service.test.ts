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
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ATRIUM_DATA: data,
    ATRIUM_PORT: String(port),
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
  return { root, data, port, env, cli };
}

test(
  "CLI 从任意目录启动 Web、并发复用、保持数据并可重复停止",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    assert.match((await f.cli("status")).stdout, /未运行/);
    assert(!existsSync(f.data));
    assert.equal((await f.cli("typo")).code, 1);
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "入口验收", cwd: f.root, template }),
    });
    assert.equal(response.status, 201);
    const { agent } = (await response.json()) as { agent: { id: string } };
    assert.match((await f.cli("list")).stdout, /a1\s+入口验收/);
    assert.equal((await f.cli("run", "a1", "--forbidden")).code, 1);
    assert.equal((await f.cli("stop")).code, 0);
    assert.match((await f.cli("stop")).stdout, /已停止/);
    assert.equal(readService(f.data), null);
    assert(existsSync(join(f.data, "atrium.sqlite")));
    assert.equal((await f.cli("--no-open")).code, 0);
    const restarted = readService(f.data)!;
    assert.notEqual(restarted.instance, record.instance);
    const overview = (await (
      await fetch(`${serviceUrl(restarted)}/api/overview`)
    ).json()) as { agents: { id: string }[] };
    assert.equal(overview.agents[0]?.id, agent.id);
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
    assert.equal(
      readFileSync(opened, "utf8"),
      serviceUrl(readService(f.data)!),
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
