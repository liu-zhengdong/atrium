import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readRestartState,
  writeRestartState,
  checkServiceHealth,
  requestDrain,
  waitForRestart,
  reclaimStoppedService,
} from "../server/supervisor.ts";
import { createServer } from "node:http";
import { alive, currentVersion, packageRoot } from "../server/service-state.ts";
import { execFile, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { childEnv } from "./child-env.ts";
import { serviceStatus } from "../server/service.ts";

const exec = promisify(execFile);

test("旧服务关监听后只接管已登记实例，且执行者 PID 必须已落盘", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-reclaim-"));
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
      "server/main.ts",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  t.after(() => {
    if (alive(child.pid!)) child.kill("SIGKILL");
    rmSync(data, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) =>
    child.stdout.once("data", () => resolve()),
  );
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const record = {
    instance: randomUUID(),
    pid: child.pid!,
    port,
    token: "a".repeat(64),
  };
  const service = new DatabaseSync(join(data, "service.sqlite"));
  service.exec(
    "CREATE TABLE service (id INTEGER PRIMARY KEY, record TEXT NOT NULL)",
  );
  service
    .prepare("INSERT INTO service(id,record) VALUES(1,?)")
    .run(JSON.stringify(record));
  service.close();
  const tasks = new DatabaseSync(join(data, "atrium.sqlite"));
  tasks.exec(
    "CREATE TABLE tasks(id INTEGER PRIMARY KEY, status TEXT, pid INTEGER)",
  );
  tasks.exec("INSERT INTO tasks VALUES(1,'running',NULL)");
  writeRestartState(data, {
    id: "rst-half-dead",
    status: "failed",
    supervisorPid: 0,
    startedAt: Date.now(),
    fromVersion: "0.1.80",
    oldPid: child.pid!,
    data,
  });
  await assert.rejects(
    serviceStatus(data),
    /已关监听但进程未退出；运行 atrium restart/,
  );
  await assert.rejects(
    reclaimStoppedService(record, data),
    /尚未记录执行者 PID/,
  );
  assert(alive(child.pid!));
  tasks.exec("UPDATE tasks SET pid=12345 WHERE id=1");
  tasks.close();
  await assert.rejects(
    reclaimStoppedService({ ...record, instance: randomUUID() }, data),
    /登记已变化/,
  );
  await reclaimStoppedService(record, data);
  assert.equal(alive(child.pid!), false);
});

test("supervisor 状态读写正确保持持久化", () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-sup-"));
  try {
    assert.equal(readRestartState(dir), null);

    const state = {
      id: "rst-test",
      startedAt: Date.now(),
      fromVersion: "0.1.0",
      status: "starting" as const,
      data: dir,
      supervisorPid: process.pid,
    };
    writeRestartState(dir, state);

    const loaded = readRestartState(dir);
    assert.deepEqual(loaded, state);

    writeRestartState(dir, {
      ...state,
      status: "success",
      newPid: 12345,
    });
    assert.equal(readRestartState(dir)?.status, "success");
    assert.equal(readRestartState(dir)?.newPid, 12345);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("损坏的待重启状态被挪开，后续请求可重新写入", () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-bad-restart-"));
  try {
    writeFileSync(join(dir, "restart-state.json"), '{"status":"waiting_idle"}');
    assert.equal(readRestartState(dir), null);
    assert.ok(
      readdirSync(dir).some((name) =>
        name.startsWith("restart-state.json.invalid-"),
      ),
    );
    const state = {
      id: "rst-next",
      status: "success" as const,
      supervisorPid: 0,
      startedAt: Date.now(),
      fromVersion: "0.1.0",
      data: dir,
    };
    writeRestartState(dir, state);
    assert.deepEqual(readRestartState(dir), state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkServiceHealth 在端口不可达时抛出异常", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-health-"));
  try {
    const mockRecord = {
      pid: 99999,
      instance: "test",
      port: 49999,
      token: "test-token",
      version: 1,
    };
    await assert.rejects(async () => {
      await checkServiceHealth(mockRecord);
    }, /fetch failed|ECONNREFUSED|connect/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("重启健康检查只看 ok：不依赖模型，也不要求旧版的 runtimes 字段", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/service")
      response.end(
        JSON.stringify({ instance: "test", pid: process.pid, stopping: false }),
      );
    else if (request.url === "/api/service/health")
      response.end(JSON.stringify({ ok: true }));
    else {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "模型不可用" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const record = {
      pid: process.pid,
      instance: "test",
      port: address.port,
      token: "test",
      version: 1,
    };
    await checkServiceHealth(record);
  } finally {
    server.close();
  }
});

test("旧服务拒绝排空时透出正文而不只报 HTTP 409", async () => {
  const server = createServer((_req, response) => {
    response.statusCode = 409;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        error: "Agent 回合未完成；仍在工作：验收（a1）。旧服务继续运行",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(
      requestDrain(
        {
          pid: process.pid,
          instance: "test",
          port: address.port,
          token: "test",
        },
        1000,
      ),
      /HTTP 409.*仍在工作：验收（a1）.*旧服务继续运行/,
    );
  } finally {
    server.close();
  }
});

test("等待回滚超时说明后台状态，不声称已经失败", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-wait-"));
  try {
    writeRestartState(dir, {
      id: "rst-test",
      status: "rolling_back",
      supervisorPid: 123,
      startedAt: Date.now(),
      fromVersion: "0.1.0",
      data: dir,
    });
    await assert.rejects(
      waitForRestart(dir, 1),
      /rolling_back.*后台任务仍可能在继续/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("currentVersion 正确获取当前 Atrium 版本", () => {
  const version = currentVersion();
  assert.equal(typeof version, "string");
  assert.match(version, /^\d+\.\d+\.\d+/);
});

test("CLI update 与 restart 命令参数解析与帮助信息", async () => {
  const bin = join(packageRoot, "bin/atrium.mjs");

  const helpRestart = await exec(process.execPath, [bin, "restart", "--help"], {
    env: childEnv(),
  });
  assert.equal(helpRestart.stderr, "");
  assert.match(helpRestart.stdout, /--wait/);
  assert.match(helpRestart.stdout, /--timeout/);

  const helpUpdate = await exec(process.execPath, [bin, "update", "--help"], {
    env: childEnv(),
  });
  assert.equal(helpUpdate.stderr, "");
  assert.match(helpUpdate.stdout, /--to/);
  assert.match(helpUpdate.stdout, /--repo/);
});
