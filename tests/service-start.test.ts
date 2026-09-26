import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { startService } from "../server/service.ts";
import {
  alive,
  currentVersion,
  readService,
  serviceUrl,
} from "../server/service-state.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { restart } from "../cli/restart.ts";
import { client } from "../cli/service.ts";
import { WORKER_FLAG } from "../cli/worker-guard.ts";

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

  await assert.rejects(restart({ "when-idle": true, data }), (error: Error) => {
    assert.equal(error.message, expected);
    assert.equal((error as { code?: string }).code, "service_outdated");
    return true;
  });

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
