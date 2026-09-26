import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  readRestartState,
  writeRestartState,
  checkServiceHealth,
  sendRollbackNotification,
  requestDrain,
  waitForRestart,
} from "../server/supervisor.ts";
import { initiatorAgent } from "../cli/restart.ts";
import { createServer } from "node:http";
import { Store } from "../server/store.ts";
import { Runtimes } from "../server/runtime.ts";
import type { RuntimeInfo } from "../shared/schema.ts";
import { createApp } from "../server/app.ts";
import { currentVersion, packageRoot } from "../server/service-state.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { childEnv } from "./child-env.ts";

const exec = promisify(execFile);

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

test("回滚告警在用户概览中可见，下一次成功后消失", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-rollback-ui-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { app } = await createApp({ auth: false, data: dir, runtime: false });
  t.after(() => app.close());
  const state = {
    id: "rst-ui",
    status: "rolled_back" as const,
    supervisorPid: process.pid,
    startedAt: Date.now(),
    fromVersion: "0.1.2",
    failedVersion: "0.1.3",
    error: "退出码 19",
    data: dir,
  };
  writeRestartState(dir, state);
  const rollback = (await app.inject({ url: "/api/overview" })).json();
  assert.deepEqual(rollback.rollback, {
    fromVersion: "0.1.2",
    failedVersion: "0.1.3",
    error: "退出码 19",
  });
  writeRestartState(dir, { ...state, status: "success" });
  assert.equal(
    (await app.inject({ url: "/api/overview" })).json().rollback,
    null,
  );
});

test("sendRollbackNotification 正确写入回滚通知至消息箱", () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-notify-"));
  try {
    const store = new Store(join(dir, "atrium.sqlite"));
    const { agent } = store.createAgent("测试 Agent", dir);

    sendRollbackNotification(dir, {
      fromVersion: "0.1.0",
      failedVersion: "0.2.0",
      error: "健康检查失败",
    });

    const box = store.box(agent.id);
    assert.equal(box.items.length, 1);
    assert.equal(box.items[0].title, "Atrium 升级回滚");
    assert.match(box.items[0].body, /已自动回滚至 v0.1.0/);
    assert.match(box.items[0].body, /健康检查失败/);
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
      await checkServiceHealth(mockRecord, dir);
    }, /fetch failed|ECONNREFUSED|connect/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("重启健康检查默认不依赖模型，显式探针失败仍被拒绝", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/service")
      response.end(
        JSON.stringify({ instance: "test", pid: process.pid, stopping: false }),
      );
    else if (request.url === "/api/service/health")
      response.end(JSON.stringify({ ok: true, runtimes: { available: true } }));
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
    await checkServiceHealth(record, "unused");
    await assert.rejects(
      checkServiceHealth(record, "unused", { probeAgent: "a1" }),
      /模型不可用/,
    );
  } finally {
    server.close();
  }
});

test("Agent 从符号链接目录启动，或只有会话路径时仍能续跑", () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-wake-"));
  try {
    const profile = join(dir, "profile");
    mkdirSync(profile);
    symlinkSync(profile, join(dir, "alias"));
    const session = join(profile, "sessions", "a.jsonl");
    mkdirSync(join(profile, "sessions"));
    writeFileSync(session, "");
    const store = new Store(join(dir, "atrium.sqlite"));
    try {
      const { agent } = store.createAgent("Self", profile);
      store.run(
        "UPDATE agents SET agent_directory=?, session_file=? WHERE id=?",
        profile,
        session,
        agent.id,
      );
      assert.equal(initiatorAgent(store, join(dir, "alias")), agent.id);
      assert.equal(initiatorAgent(store, undefined, session), agent.id);
      assert.equal(initiatorAgent(store, join(dir, "another")), undefined);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("排空在回合结束后才同步末尾轨迹；到期列出忙碌身份且旧服务可继续", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-drain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "atrium.sqlite"));
  t.after(() => store.close());
  const { agent } = store.createAgent("验收", dir);
  const info: RuntimeInfo = {
    runtimeId: randomUUID(),
    generation: randomUUID(),
    sessionId: randomUUID(),
    pid: process.pid,
    ownerPid: process.pid,
    sessionFile: null,
    cwd: dir,
    mode: "rpc",
    busy: true,
    model: "fixture",
  };
  const events: string[] = [];
  let statusCalls = 0;
  let finishAfter = 4;
  const openTurns = new Map<string, { generation: string }>();
  const runtime = Object.assign(Object.create(Runtimes.prototype), {
    connections: new Map([[agent.id, { info }]]),
    pumping: new Map(),
    connecting: new Map(),
    turns: { current: (id: string) => openTurns.get(id) ?? null },
    store,
    draining: false,
    rpc: async () => {
      statusCalls++;
      events.push(statusCalls < finishAfter ? "busy" : "idle");
      return { ...info, busy: statusCalls < finishAfter };
    },
    capture: async (
      _id: string,
      _info: RuntimeInfo,
      pages: number,
      strict: boolean,
    ) => {
      assert.equal(pages, 100);
      assert.equal(strict, true);
      events.push("trace_flushed");
    },
  }) as Runtimes;
  const agents = await runtime.prepareShutdown(1000);
  assert.deepEqual(agents, [agent.id]);
  assert.deepEqual(events, ["busy", "busy", "busy", "idle", "trace_flushed"]);
  assert.equal((runtime as unknown as { draining: boolean }).draining, true);
  await assert.rejects(runtime.start(agent.id), /服务正在排空任务/);
  await assert.rejects(
    (
      runtime as unknown as {
        operation: (id: string, work: () => Promise<void>) => Promise<void>;
      }
    ).operation(agent.id, async () => {}),
    /服务正在排空任务/,
  );

  (runtime as unknown as { draining: boolean }).draining = false;
  finishAfter = Infinity;
  statusCalls = 0;
  events.length = 0;
  await assert.rejects(runtime.prepareShutdown(210), (error: unknown) => {
    assert.match(String(error), /验收（a1）/);
    assert.match(
      String(error),
      /旧服务继续运行.*atrium restart.*--agent-timeout/,
    );
    return true;
  });
  assert.equal(events.includes("trace_flushed"), false);
  assert.equal((runtime as unknown as { draining: boolean }).draining, false);

  // The gateway can briefly report idle while Pi is still publishing the
  // final tool/result events. A known open run must prevent a premature stop.
  finishAfter = 1;
  statusCalls = 0;
  events.length = 0;
  openTurns.set(agent.id, { generation: info.generation });
  let flushes = 0;
  (runtime as unknown as { capture: () => Promise<void> }).capture =
    async () => {
      flushes++;
      if (flushes === 3) openTurns.delete(agent.id);
    };
  assert.deepEqual(await runtime.prepareShutdown(1000), [agent.id]);
  assert.equal(flushes, 3);
  assert.equal(statusCalls, 3);
  assert.equal((runtime as unknown as { draining: boolean }).draining, true);

  (runtime as unknown as { draining: boolean }).draining = false;
  finishAfter = 1;
  statusCalls = 0;
  (runtime as unknown as { capture: () => Promise<void> }).capture =
    async () => {
      throw new Error("trace unavailable");
    };
  await assert.rejects(runtime.prepareShutdown(1000), /trace unavailable/);
  assert.equal((runtime as unknown as { draining: boolean }).draining, false);
});

test("排空中途发起方断开：中止排空并恢复运行（#231）", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-drain-abort-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "atrium.sqlite"));
  t.after(() => store.close());
  const { agent } = store.createAgent("验收", dir);
  const info: RuntimeInfo = {
    runtimeId: randomUUID(),
    generation: randomUUID(),
    sessionId: randomUUID(),
    pid: process.pid,
    ownerPid: process.pid,
    sessionFile: null,
    cwd: dir,
    mode: "rpc",
    busy: true,
    model: "fixture",
  };
  const runtime = Object.assign(Object.create(Runtimes.prototype), {
    connections: new Map([[agent.id, { info }]]),
    pumping: new Map(),
    connecting: new Map(),
    turns: { current: () => null },
    store,
    draining: false,
    rpc: async () => ({ ...info, busy: true }),
    capture: async () => {},
  }) as Runtimes;
  const abort = new AbortController();
  const drain = runtime.prepareShutdown(30_000, abort.signal);
  const timer = setTimeout(() => abort.abort(), 250);
  await assert.rejects(drain, /排空中止：发起方已断开/);
  clearTimeout(timer);
  assert.equal((runtime as unknown as { draining: boolean }).draining, false);
  // 已恢复运行：再次排空能进入等待（报忙碌超时），而不是被「正在排空」拒绝。
  await assert.rejects(runtime.prepareShutdown(120), /旧服务继续运行/);
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
