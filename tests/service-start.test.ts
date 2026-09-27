import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { startService } from "../server/service.ts";
import {
  alive,
  currentVersion,
  packageRoot,
  readService,
  serviceUrl,
} from "../server/service-state.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { client } from "../cli/service.ts";
import { WORKER_FLAG } from "../cli/worker-guard.ts";
import { writeRestartState } from "../server/supervisor.ts";

const entry = "tests/fixtures/fake-slow-service.ts";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** 假服务读 ATRIUM_* 变量（服务环境白名单只放行这类），用完恢复。 */
async function fixture(
  t: { after: (fn: () => Promise<void> | void) => void },
  env: Record<string, string>,
) {
  const root = mkdtempSync(join(tmpdir(), "atrium-start-"));
  const data = join(root, "data");
  const saved = { ...process.env };
  delete process.env[WORKER_FLAG];
  Object.assign(process.env, {
    ATRIUM_PORT: String(await freePort()),
    ATRIUM_DATA: data,
    ...env,
  });
  t.after(async () => {
    const record = readService(data);
    if (record && alive(record.pid)) {
      process.kill(record.pid, "SIGTERM");
      for (let i = 0; i < 50 && alive(record.pid); i++) await delay(100);
    }
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  });
  return data;
}

test("冷启动慢但进程还活着：超过停滞窗口也继续等到就绪，并提示启动中", async (t) => {
  const data = await fixture(t, { ATRIUM_FAKE_DELAY_MS: "3000" });
  const notices: string[] = [];
  const started = Date.now();
  const record = await startService(data, {
    entry,
    stallMs: 1000,
    noticeMs: 500,
    totalMs: 30000,
    notice: (message) => notices.push(message),
  });
  assert.ok(Date.now() - started >= 3000, "应等到假服务就绪");
  assert.ok(alive(record.pid));
  assert.equal(notices.length, 1, "启动中提示只打一行");
  assert.match(notices[0]!, /Atrium 服务启动中…/);
  assert.match(notices[0]!, /service\.log/);
});

test("服务进程退出：立即报失败并给日志位置和最近输出", async (t) => {
  const data = await fixture(t, { ATRIUM_FAKE_EXIT: "3" });
  const started = Date.now();
  await assert.rejects(
    startService(data, { entry, notice: () => {} }),
    (error: Error) => {
      assert.match(error.message, /Atrium 启动失败（退出码 3）/);
      assert.ok(error.message.includes(join(data, "service.log")));
      assert.match(error.message, /配置损坏，无法启动/);
      return true;
    },
  );
  // 总上限是 60 秒；进程退出不该等满。
  assert.ok(Date.now() - started < 30000);
});

test("旧服务缺接口：报版本不匹配，不再落到认证报错", async (t) => {
  const data = await fixture(t, { ATRIUM_FAKE_VERSION: "0.0.1" });
  const record = await startService(data, { entry, notice: () => {} });
  const expected = `服务版本 0.0.1 旧于命令行 ${currentVersion()}，不支持此操作；先 atrium restart 到新版`;

  mkdirSync(join(data), { recursive: true });
  writeFileSync(userTokenPath(data), `${"a".repeat(64)}\n`, { mode: 0o600 });
  await assert.rejects(
    client(serviceUrl(record), data).get("/tasks/t1/new-thing"),
    (error: Error) => {
      assert.equal(error.message, expected);
      return true;
    },
  );
});

test("版本相同的服务回 404：按原错误报，不误报版本不匹配", async (t) => {
  const data = await fixture(t, { ATRIUM_FAKE_VERSION: currentVersion() });
  const record = await startService(data, { entry, notice: () => {} });
  writeFileSync(userTokenPath(data), `${"a".repeat(64)}\n`, { mode: 0o600 });
  await assert.rejects(
    client(serviceUrl(record), data).get("/nothing"),
    (error: Error) => {
      assert.equal(error.message, "接口不存在");
      return true;
    },
  );
});

test("重启进行中：不抢着自己拉服务，等 supervisor 拉起的新服务就绪后照常返回", async (t) => {
  const data = await fixture(t, { ATRIUM_FAKE_DELAY_MS: "0" });
  // 充当 supervisor 的活进程；状态停在 starting，还没有服务登记。
  const supervisor = spawn(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    {
      stdio: "ignore",
    },
  );
  t.after(() => {
    if (supervisor.exitCode == null) supervisor.kill("SIGKILL");
  });
  writeRestartState(data, {
    id: "rst-wait",
    status: "starting",
    supervisorPid: supervisor.pid!,
    startedAt: Date.now(),
    fromVersion: currentVersion(),
    data,
  });
  const notices: string[] = [];
  await assert.rejects(
    startService(data, {
      entry,
      totalMs: 800,
      noticeMs: 200,
      notice: (message) => notices.push(message),
    }),
    /正在重启（starting），已等 1 秒仍未就绪；运行 atrium restart --wait/,
  );
  assert.equal(readService(data), null, "重启进行中不该自己拉起服务");
  assert.match(notices.join("\n"), /正在重启，等新服务就绪/);
  // supervisor 拉起新服务（这里直接起假服务代劳）；等待方拿到的就是它，不另起一个。
  const waiting = startService(data, { entry, notice: () => {} });
  await delay(300);
  writeRestartState(data, {
    id: "rst-wait",
    status: "checking",
    supervisorPid: supervisor.pid!,
    startedAt: Date.now(),
    fromVersion: currentVersion(),
    data,
  });
  const fresh = spawn(
    process.execPath,
    ["--import", "tsx", join(packageRoot, entry)],
    { env: { ...process.env }, stdio: "ignore" },
  );
  t.after(() => {
    if (fresh.exitCode == null) fresh.kill("SIGKILL");
  });
  const record = await waiting;
  assert.equal(record.pid, fresh.pid);
});

test("连接被拒（旧服务刚关）：等服务就绪后重发一次；其他错误不重发", async (t) => {
  const data = await fixture(t, { ATRIUM_FAKE_VERSION: currentVersion() });
  const record = await startService(data, { entry, notice: () => {} });
  writeFileSync(userTokenPath(data), `${"a".repeat(64)}\n`, { mode: 0o600 });
  const closed = `http://127.0.0.1:${await freePort()}`;
  let reconnects = 0;
  await assert.rejects(
    client(closed, data, async () => {
      reconnects++;
      return serviceUrl(record);
    }).get("/nothing"),
    (error: Error) => {
      // 重发到了新服务：拿到的是新服务的 404，而不是连接失败。
      assert.equal(error.message, "接口不存在");
      return true;
    },
  );
  assert.equal(reconnects, 1);
  await assert.rejects(client(closed, data).get("/nothing"), {
    code: "service_unavailable",
  });
});
