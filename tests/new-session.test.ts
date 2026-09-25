import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { Runtimes } from "../server/runtime.ts";
import type { RuntimeInfo } from "../shared/schema.ts";

async function fixture(t: TestContext, running = false) {
  const root = mkdtempSync(join(tmpdir(), "atrium-new-session-"));
  const data = join(root, "data");
  const acp = join(root, "acp", "identities");
  mkdirSync(data, { recursive: true });
  mkdirSync(acp, { recursive: true });
  const previousEnv = process.env.PI_ACP_DIR;
  process.env.PI_ACP_DIR = join(root, "acp");
  const store = new Store(join(data, "atrium.db"));
  const { agent } = store.createAgent("Atlas", root);
  const account = store.run(
    "INSERT INTO accounts(provider,name,type) VALUES('fixture','test','api_key')",
  ).lastInsertRowid;
  store.run(
    "INSERT INTO account_assignments(agent_id,provider,account_number) VALUES(?,?,?)",
    agent.id,
    "fixture",
    account,
  );
  const oldFile = join(root, "old.jsonl");
  const newFile = join(root, "new.jsonl");
  writeFileSync(oldFile, "old conversation stays intact\n");
  const cursor = join(acp, `${agent.id}.cursor.json`);
  writeFileSync(cursor, JSON.stringify({ sessionFile: oldFile }));
  store.run(
    "UPDATE agents SET session_file=?,acp_session_id=? WHERE id=?",
    oldFile,
    randomUUID(),
    agent.id,
  );
  const runtimes = new Runtimes(
    store,
    data,
    () => {},
    () => "http://127.0.0.1:4335",
    undefined,
    join(root, "desktops"),
  );
  let busy = false;
  let owned = true;
  let reject = false;
  const calls: string[] = [];
  const info: RuntimeInfo = {
    runtimeId: randomUUID(),
    generation: randomUUID(),
    sessionId: randomUUID(),
    pid: process.pid,
    ownerPid: process.pid,
    identityId: agent.id,
    sessionFile: oldFile,
    cwd: root,
    mode: "rpc",
    busy: false,
    model: "fixture",
  };
  if (running)
    runtimes.connections.set(agent.id, { connection: null as never, info });
  const internals = runtimes as unknown as {
    owned(id: string): boolean;
    rpc(method: string, params: unknown): Promise<unknown>;
    capture(id: string, info: RuntimeInfo): Promise<void>;
  };
  t.mock.method(internals, "owned", () => owned);
  t.mock.method(internals, "rpc", async (method: string) => {
    calls.push(method);
    if (method === "_pi/runtime/status") return { ...info, busy };
    return {};
  });
  t.mock.method(internals, "capture", async () => {});
  t.mock.method(runtimes, "discover", async () => {});
  t.mock.method(runtimes, "stop", async () => {
    calls.push("stop");
    runtimes.connections.delete(agent.id);
  });
  t.mock.method(
    runtimes,
    "start",
    async (_id: string, _automatic: boolean, fresh: boolean) => {
      calls.push(`start fresh=${fresh}`);
      if (reject) {
        writeFileSync(cursor, "failed start cursor");
        store.run(
          "UPDATE agents SET session_file=? WHERE id=?",
          newFile,
          agent.id,
        );
        throw new Error("model unavailable");
      }
      writeFileSync(newFile, "new session\n");
      writeFileSync(cursor, JSON.stringify({ sessionFile: newFile }));
      store.run(
        "UPDATE agents SET session_file=? WHERE id=?",
        newFile,
        agent.id,
      );
    },
  );
  t.mock.method(runtimes, "pump", async () => {
    calls.push("pump");
  });
  t.after(async () => {
    await runtimes.close();
    store.close();
    if (previousEnv === undefined) delete process.env.PI_ACP_DIR;
    else process.env.PI_ACP_DIR = previousEnv;
    rmSync(root, { recursive: true, force: true });
  });
  return {
    runtimes,
    store,
    agent,
    oldFile,
    newFile,
    cursor,
    calls,
    setBusy: (value: boolean) => {
      busy = value;
    },
    setOwned: (value: boolean) => {
      owned = value;
    },
    setReject: (value: boolean) => {
      reject = value;
    },
  };
}

test("离线开新会话保留旧文件、更新指针，并只启动 fresh", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.runtimes.newSession(f.agent.id), {
    old_session_file: f.oldFile,
    new_session_file: f.newFile,
  });
  assert.equal(
    readFileSync(f.oldFile, "utf8"),
    "old conversation stays intact\n",
  );
  assert.equal(
    JSON.parse(readFileSync(f.cursor, "utf8")).sessionFile,
    f.newFile,
  );
  assert.deepEqual(f.calls, ["start fresh=true", "pump"]);
  assert.match(
    f.store.agent(f.agent.id).session_reset_reason!,
    /手动开启新会话/,
  );
});

test("在忙时等待、空闲后才停止；超时不动旧实例", async (t) => {
  const f = await fixture(t, true);
  f.setBusy(true);
  const switching = f.runtimes.newSession(f.agent.id, 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(!f.calls.includes("stop"));
  await assert.rejects(f.runtimes.newSession(f.agent.id), /切换会话/);
  f.setBusy(false);
  await switching;
  assert(f.calls.indexOf("_pi/runtime/status") < f.calls.indexOf("stop"));
  assert(f.calls.indexOf("stop") < f.calls.indexOf("start fresh=true"));
  const timeout = await fixture(t, true);
  timeout.setBusy(true);
  await assert.rejects(
    timeout.runtimes.newSession(timeout.agent.id, 0.02),
    /当前回合仍未结束/,
  );
  assert(!timeout.calls.includes("stop"));
  assert.equal(
    readFileSync(timeout.cursor, "utf8"),
    JSON.stringify({ sessionFile: timeout.oldFile }),
  );
});

test("非本服务实例不抢占；启动失败恢复 cursor 和旧会话绑定", async (t) => {
  const foreign = await fixture(t, true);
  foreign.setOwned(false);
  await assert.rejects(
    foreign.runtimes.newSession(foreign.agent.id),
    /其他终端运行/,
  );
  assert(!foreign.calls.includes("stop"));
  const failure = await fixture(t, true);
  failure.setReject(true);
  await assert.rejects(
    failure.runtimes.newSession(failure.agent.id),
    /新会话启动失败.*model unavailable/,
  );
  assert.equal(
    JSON.parse(readFileSync(failure.cursor, "utf8")).sessionFile,
    failure.oldFile,
  );
  assert.equal(
    failure.store.agent(failure.agent.id).session_file,
    failure.oldFile,
  );
  assert(existsSync(failure.oldFile));
});
