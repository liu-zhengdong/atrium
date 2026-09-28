import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { EventInbox } from "../server/tasks/events/events.ts";
import { createApp } from "../server/app.ts";
import { ensureTaskTables } from "../server/tasks/ledger/ledger.ts";
import {
  SecretaryFallback,
  resumeCommand,
  resumeTurn,
} from "../server/tasks/secretary/secretary-fallback.ts";
import { claimSecretary } from "../server/tasks/secretary/secretary-lock.ts";
import {
  loadSecretarySession,
  saveSecretarySession,
  wakeCount,
} from "../server/tasks/secretary/secretary-session.ts";
import { sessionStore } from "../cli/chat.ts";
import { writeFakeBin } from "./fake-bin.ts";
import { removeTemp } from "./temp-dir.ts";

async function until(check: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`等不到：${what}`);
    await delay(10);
  }
}

function parsedResumeLog<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

test("恢复命令指定同一会话，拒绝不合法的编号", () => {
  const codex = {
    tool: "codex" as const,
    sessionId: "019c6e27-e55b-73d1-87d8-4e01f1f75043",
    cwd: "/tmp/work",
  };
  assert.deepEqual(resumeCommand(codex, "事件").args.slice(-2), [
    codex.sessionId,
    "-",
  ]);
  assert.equal(resumeCommand(codex, "事件").stdin, "事件");
  const opencode = {
    tool: "opencode" as const,
    sessionId: "ses_123abc",
    cwd: "/tmp/work",
  };
  assert.deepEqual(resumeCommand(opencode, "事件").args, [
    "run",
    "--session",
    opencode.sessionId,
    "--auto",
    "--",
    "事件",
  ]);
  assert.throws(() => resumeCommand({ ...codex, sessionId: "--last" }, "事件"));
});

test("坏的秘书会话记录移开后其余数据仍可读取", () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-fallback-bad-"));
  try {
    const directory = join(data, "secretary");
    mkdirSync(directory);
    writeFileSync(join(directory, "active.json"), "not json");
    assert.equal(loadSecretarySession(data), undefined);
    assert.equal(existsSync(join(directory, "active.json")), false);
    saveSecretarySession(data, {
      tool: "opencode",
      sessionId: "ses_123abc",
      cwd: data,
    });
    assert.equal(loadSecretarySession(data)?.sessionId, "ses_123abc");
  } finally {
    removeTemp(data);
  }
});

test("原生界面与 ACP 共用 opencode-session.json，恢复读取同一个编号", () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-fallback-session-"));
  try {
    const store = sessionStore(data, "opencode", data);
    store.save("ses_123abc");
    assert.equal(store.load(), "ses_123abc");
    assert.equal(
      JSON.parse(
        readFileSync(join(data, "secretary", "opencode-session.json"), "utf8"),
      ).sessionId,
      "ses_123abc",
    );
    assert.deepEqual(loadSecretarySession(data), {
      tool: "opencode",
      sessionId: "ses_123abc",
      cwd: data,
    });
  } finally {
    removeTemp(data);
  }
});

test("opencode 后台恢复使用秘书独立数据目录且只同步 API key", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-fallback-opencode-"));
  const bin = join(data, "bin");
  const userHome = join(data, "user-data");
  const auth = join(userHome, "opencode", "auth.json");
  const log = join(data, "resume.json");
  mkdirSync(bin);
  mkdirSync(join(userHome, "opencode"), { recursive: true });
  const userAuth = JSON.stringify({
    provider: { type: "api", key: "test credential" },
    openai: {
      type: "oauth",
      refresh: "secret refresh",
      access: "secret access",
    },
  });
  writeFileSync(auth, userAuth, { mode: 0o600 });
  const executable = join(bin, "opencode");
  writeFakeBin(
    executable,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst target = process.env.ATRIUM_TEST_RESUME_LOG;\nconst tmp = target + '.tmp';\nfs.writeFileSync(tmp, JSON.stringify({args: process.argv.slice(2), home: process.env.XDG_DATA_HOME}));\nfs.renameSync(tmp, target);\n`,
  );
  const oldPath = process.env.PATH;
  const oldHome = process.env.XDG_DATA_HOME;
  const oldLog = process.env.ATRIUM_TEST_RESUME_LOG;
  process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
  process.env.XDG_DATA_HOME = userHome;
  process.env.ATRIUM_TEST_RESUME_LOG = log;
  try {
    const ok = await resumeTurn(
      { tool: "opencode", sessionId: "ses_123abc", cwd: data },
      "事件",
      new AbortController().signal,
      () => {},
      data,
    );
    assert.equal(ok, true);
    const recorded = JSON.parse(readFileSync(log, "utf8")) as {
      args: string[];
      home: string;
    };
    assert.deepEqual(recorded.args, [
      "run",
      "--session",
      "ses_123abc",
      "--auto",
      "--",
      "事件",
    ]);
    assert.equal(recorded.home, join(data, "secretary", "opencode-home"));
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(recorded.home, "opencode", "auth.json"), "utf8"),
      ),
      { provider: { type: "api", key: "test credential" } },
      "后台恢复后秘书目录里没有用户 OAuth 条目",
    );
    assert.equal(readFileSync(auth, "utf8"), userAuth);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldHome;
    if (oldLog === undefined) delete process.env.ATRIUM_TEST_RESUME_LOG;
    else process.env.ATRIUM_TEST_RESUME_LOG = oldLog;
    removeTemp(data);
  }
});

test("秘书会话所有权跨进程状态原子领取，存活子进程阻止误回收", () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-fallback-lock-"));
  try {
    const first = claimSecretary(data);
    assert.ok(first);
    assert.equal(claimSecretary(data), null);
    first.release();
    const db = new DatabaseSync(join(data, "secretary", "owner.sqlite"));
    db.prepare(
      "INSERT INTO owner(id,token,pid,child_pid) VALUES (1,'stale',999999,?)",
    ).run(process.pid);
    assert.equal(claimSecretary(data), null, "存活的恢复进程仍占有会话");
    db.prepare("UPDATE owner SET child_pid=999999 WHERE id=1").run();
    const recovered = claimSecretary(data);
    assert.ok(recovered);
    recovered.release();
    db.close();
  } finally {
    removeTemp(data);
  }
});

test("无界面恢复会话处理事件；界面持锁时不另起；失败不记送达", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-fallback-"));
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  const calls: string[] = [];
  let success = false;
  const fallback = new SecretaryFallback(inbox, data, {
    graceMs: 10,
    runTurn: async (session, prompt) => {
      calls.push(`${session.tool}:${prompt}`);
      return success;
    },
  });
  try {
    saveSecretarySession(data, {
      tool: "codex",
      sessionId: "019c6e27-e55b-73d1-87d8-4e01f1f75043",
      cwd: data,
    });
    assert.equal(loadSecretarySession(data)?.tool, "codex");
    const ui = claimSecretary(data);
    assert.ok(ui);
    fallback.start();
    const event = inbox.publish({
      subscriber: "secretary",
      source: "runner",
      kind: "done",
      key: "t1:done",
      detail: { title: "修登录" },
    });
    await delay(100);
    assert.equal(calls.length, 0, "界面占用期间不恢复");
    ui.release();
    await until(() => calls.length > 0, "失败的一轮");
    assert.equal(
      inbox.list("secretary", { limit: 1 }).events[0]!.delivered_at,
      null,
    );
    assert.equal(wakeCount(data), 0);
    success = true;
    await until(
      () =>
        inbox.list("secretary", { limit: 1 }).events[0]!.delivered_at !== null,
      "成功送达",
      10000,
    );
    assert.match(calls.at(-1)!, /#1 done 修登录/);
    assert.match(calls.at(-1)!, /atrium events ack 1/);
    assert.equal(wakeCount(data), 1);
    assert.equal(
      inbox.list("secretary", { limit: 1 }).events[0]!.acked_at,
      null,
    );
    assert.equal(event.id, 1);
  } finally {
    await fallback.close();
    db.close();
    removeTemp(data);
  }
});

test("服务真实拉起一次性 codex 恢复进程并登记送达", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-fallback-app-"));
  const bin = join(data, "bin");
  const log = join(data, "resume.json");
  mkdirSync(bin);
  const executable = join(bin, "codex");
  writeFakeBin(
    executable,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nlet input = '';\nprocess.stdin.on('data', chunk => input += chunk);\nprocess.stdin.on('end', () => { const target = process.env.ATRIUM_TEST_RESUME_LOG; const tmp = target + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({args: process.argv.slice(2), input})); fs.renameSync(tmp, target); });\n`,
  );
  const oldPath = process.env.PATH;
  const oldLog = process.env.ATRIUM_TEST_RESUME_LOG;
  process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
  process.env.ATRIUM_TEST_RESUME_LOG = log;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    saveSecretarySession(data, {
      tool: "codex",
      sessionId: "019c6e27-e55b-73d1-87d8-4e01f1f75043",
      cwd: data,
    });
    app = await createApp({
      data,
      auth: false,
      tasks: { batchMs: 10 },
      secretary: { graceMs: 10 },
    });
    app.taskRunner.inbox.publish({
      subscriber: "secretary",
      source: "runner",
      kind: "done",
      key: "one",
    });
    await until(
      () => parsedResumeLog(log) !== undefined,
      "恢复进程写出可解析的日志",
    );
    await until(
      () =>
        typeof app!.taskRunner.inbox.list("secretary", { limit: 1 }).events[0]
          ?.delivered_at === "number",
      "服务登记送达",
    );
    const resume = parsedResumeLog<{ args: string[]; input: string }>(log)!;
    assert.deepEqual(resume.args.slice(-2), [
      "019c6e27-e55b-73d1-87d8-4e01f1f75043",
      "-",
    ]);
    assert.match(resume.input, /atrium events ack 1/);
  } finally {
    await app?.app.close();
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.ATRIUM_TEST_RESUME_LOG;
    else process.env.ATRIUM_TEST_RESUME_LOG = oldLog;
    removeTemp(data);
  }
});
