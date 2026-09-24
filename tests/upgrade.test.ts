import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  readRestartState,
  writeRestartState,
  checkServiceHealth,
  sendRollbackNotification,
} from "../server/supervisor.ts";
import { Store } from "../server/store.ts";
import { currentVersion, packageRoot } from "../server/service-state.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

test("currentVersion 正确获取当前 Atrium 版本", () => {
  const version = currentVersion();
  assert.equal(typeof version, "string");
  assert.match(version, /^\d+\.\d+\.\d+/);
});

test("CLI update 与 restart 命令参数解析与帮助信息", async () => {
  const bin = join(packageRoot, "bin/atrium.mjs");

  const helpRestart = await exec(process.execPath, [bin, "restart", "--help"]);
  assert.equal(helpRestart.stderr, "");
  assert.match(helpRestart.stdout, /--wait/);
  assert.match(helpRestart.stdout, /--timeout/);

  const helpUpdate = await exec(process.execPath, [bin, "update", "--help"]);
  assert.equal(helpUpdate.stderr, "");
  assert.match(helpUpdate.stdout, /--to/);
  assert.match(helpUpdate.stdout, /--repo/);
});
