import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { Runtimes } from "../server/runtime.ts";
import type { RuntimeInfo } from "../shared/schema.ts";

function assignFixture(store: Store, id: string) {
  // Runtime RPC is stubbed; only the assignment gate needs a fixture account.
  const account = store.run(
    "INSERT INTO accounts(provider,name,type) VALUES('fixture','test','api_key')",
  ).lastInsertRowid;
  store.run(
    "INSERT INTO account_assignments(agent_id,provider,account_number) VALUES(?,?,?)",
    id,
    "fixture",
    account,
  );
}

type PrivateRuntime = {
  rpc(method: string, params: unknown): Promise<unknown>;
  bind(id: string, selector: { sessionId: string }): Promise<void>;
  owned(id: string): boolean;
};

async function fixture(
  t: TestContext,
  failure: "import" | "load" | "turn" | "twice" | "deliver" | "other" | "multi",
) {
  const root = mkdtempSync(join(tmpdir(), "atrium-session-fallback-"));
  const data = join(root, "data");
  mkdirSync(join(data, "credentials"), { recursive: true });
  const store = new Store(join(data, "atrium.db"));
  const { agent, token } = store.createAgent("Atlas", root);
  assignFixture(store, agent.id);
  const oldFile = join(root, "old-session.jsonl");
  writeFileSync(oldFile, "old conversation stays intact\n");
  writeFileSync(
    join(data, "credentials", `${agent.id}.json`),
    JSON.stringify({ token }),
  );
  store.run("UPDATE agents SET session_file=? WHERE id=?", oldFile, agent.id);
  if (failure !== "import")
    store.run(
      "UPDATE agents SET acp_session_id=? WHERE id=?",
      randomUUID(),
      agent.id,
    );
  const calls: string[] = [];
  const delivered: string[] = [];
  const sessions = new Map<string, RuntimeInfo>();
  const seen = new Set<string>();
  const ends = new Map<string, number>();
  const broken = new Set<string>();
  const previous = store.one<{ acp_session_id: string }>(
    "SELECT acp_session_id FROM agents WHERE id=?",
    agent.id,
  )?.acp_session_id;
  const make = (sessionId: string): RuntimeInfo => ({
    runtimeId: randomUUID(),
    generation: randomUUID(),
    sessionId,
    pid: process.pid,
    ownerPid: process.pid,
    identityId: null,
    sessionFile:
      sessionId === previous ? oldFile : join(root, `${sessionId}.jsonl`),
    cwd: root,
    mode: "rpc",
    busy: false,
    model: "fixture",
  });
  t.mock.method(
    Runtimes.prototype as unknown as PrivateRuntime,
    "rpc",
    async (method: string, params: unknown) => {
      calls.push(method);
      if (method === "_pi/runtime/list") return { runtimes: [] };
      if (method === "_pi/session/import") {
        if (failure === "import") throw new Error("import corrupt session");
        return { sessionId: randomUUID() };
      }
      if (method === "session/load" && failure === "load")
        throw new Error("load corrupt session");
      if (method === "session/new") return { sessionId: randomUUID() };
      if (method === "_pi/runtime/status") return sessions.get(agent.id);
      if (method === "_pi/runtime/deliver") {
        const input = params as { text: string; sessionId: string };
        delivered.push(input.sessionId);
        if (failure === "deliver" && input.sessionId === previous)
          throw new Error("prompt-capture: no capture");
        if (
          failure === "turn" ||
          failure === "twice" ||
          failure === "other" ||
          failure === "multi"
        )
          broken.add(input.sessionId);
        return { accepted: true };
      }
      if (method === "_pi/runtime/events") {
        const input = params as {
          sessionId: string;
          runtimeId: string;
          generation: string;
        };
        const { runtimeId, generation, sessionId } = sessions.get(agent.id)!;
        const target = { runtimeId, generation, sessionId };
        const isBroken =
          broken.has(input.sessionId) &&
          (input.sessionId === previous || failure === "twice");
        if (!broken.has(input.sessionId) || seen.has(input.sessionId))
          return {
            ...target,
            items: [],
            nextAfter: ends.get(input.sessionId) ?? 0,
            hasMore: false,
            gap: false,
          };
        seen.add(input.sessionId);
        const at = Date.now();
        const items = (
          [
            { seq: 1, at, kind: "run_start" },
            { seq: 2, at, kind: "delivery" },
            ...(isBroken
              ? [
                  {
                    seq: 3,
                    at,
                    kind: "message",
                    name: "assistant",
                    error: true,
                    text:
                      failure === "other"
                        ? "model quota exhausted"
                        : "prompt-capture: no capture",
                  },
                ]
              : []),
            // Pi can start several turns in one run; the last may carry no delivery.
            ...(isBroken && failure === "multi"
              ? [
                  { seq: 4, at, kind: "run_start" },
                  {
                    seq: 5,
                    at,
                    kind: "message",
                    name: "assistant",
                    error: true,
                    text: "prompt-capture: no capture",
                  },
                ]
              : []),
            { seq: 6, at, kind: "run_end" },
          ] as Record<string, unknown>[]
        ).map((item, index) => ({ ...item, seq: index + 1 }));
        ends.set(input.sessionId, items.length);
        return {
          ...target,
          // Trace sequence numbers are contiguous; number the events in order.
          items,
          nextAfter: items.length,
          hasMore: false,
          gap: false,
        };
      }
      return {};
    },
  );
  t.mock.method(
    Runtimes.prototype as unknown as PrivateRuntime,
    "bind",
    async (id: string, selector: { sessionId: string }) => {
      const info = make(selector.sessionId);
      sessions.set(id, info);
      store.run(
        "UPDATE agents SET runtime_id=?,runtime_pid=?,acp_session_id=?,session_file=? WHERE id=?",
        info.runtimeId,
        info.pid,
        info.sessionId,
        info.sessionFile,
        id,
      );
      runtimes.connections.set(id, { connection: null as never, info });
    },
  );
  t.mock.method(
    Runtimes.prototype as unknown as PrivateRuntime,
    "owned",
    () => true,
  );
  const runtimes = new Runtimes(
    store,
    data,
    () => {},
    () => "http://127.0.0.1:4399",
    undefined,
    join(root, "desktops"),
  );
  t.after(async () => {
    await runtimes.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.queue(agent.id, "direct", "respond to this turn");
  await runtimes.start(agent.id);
  return { store, agent, oldFile, calls, delivered };
}

test("旧会话导入失败，开新会话并投递，保留原文件和详情记录", async (t) => {
  const { store, agent, oldFile, calls, delivered } = await fixture(
    t,
    "import",
  );
  assert.deepEqual(delivered.length, 1);
  assert(calls.includes("session/new"));
  assert.notEqual(store.agent(agent.id).session_file, oldFile);
  assert.equal(
    readFileSync(oldFile, "utf8"),
    "old conversation stays intact\n",
  );
  assert.match(
    store.agent(agent.id).session_reset_reason!,
    /import corrupt session/,
  );
  assert.equal(store.failure(agent.id), null);
});

test("旧会话加载失败也回退到新会话", async (t) => {
  const { store, agent, calls, delivered } = await fixture(t, "load");
  assert.equal(delivered.length, 1);
  assert(calls.includes("session/close"));
  assert.match(
    store.agent(agent.id).session_reset_reason!,
    /load corrupt session/,
  );
});

test("恢复后首轮 prompt-capture：换会话重投，不标记出错", async (t) => {
  const { store, agent, calls, delivered } = await fixture(t, "turn");
  assert.equal(delivered.length, 2);
  assert.notEqual(delivered[0], delivered[1]);
  assert.equal(calls.filter((method) => method === "session/new").length, 1);
  assert.equal(store.failure(agent.id), null);
  assert.match(store.agent(agent.id).session_reset_reason!, /prompt-capture/);
});

test("恢复后同一次运行连开多轮、末轮没有投递：仍换会话重投", async (t) => {
  const { store, agent, delivered } = await fixture(t, "multi");
  assert.equal(delivered.length, 2);
  assert.notEqual(delivered[0], delivered[1]);
  assert.equal(store.failure(agent.id), null);
  assert.match(store.agent(agent.id).session_reset_reason!, /prompt-capture/);
});

test("恢复后首轮投递即报 prompt-capture：换会话重投", async (t) => {
  const { store, agent, delivered } = await fixture(t, "deliver");
  assert.equal(delivered.length, 2);
  assert.notEqual(delivered[0], delivered[1]);
  assert.equal(store.failure(agent.id), null);
  assert.match(store.agent(agent.id).session_reset_reason!, /prompt-capture/);
});

test("普通模型错误不重置恢复的会话", async (t) => {
  const { store, agent, calls, delivered } = await fixture(t, "other");
  assert.equal(delivered.length, 1);
  assert.equal(calls.filter((call) => call === "session/new").length, 0);
  assert.equal(store.agent(agent.id).session_reset_at, null);
  assert.match(store.failure(agent.id)!.text, /model quota exhausted/);
});

test("具名身份新会话避开 pi-atrium 的旧游标，旧指针另存", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-identity-cursor-"));
  const original = process.env.PI_ACP_DIR;
  process.env.PI_ACP_DIR = root;
  t.after(() => {
    if (original === undefined) delete process.env.PI_ACP_DIR;
    else process.env.PI_ACP_DIR = original;
    rmSync(root, { recursive: true, force: true });
  });
  const id = randomUUID();
  const directory = join(root, "identities");
  mkdirSync(directory);
  const cursor = join(directory, `${id}.cursor.json`);
  writeFileSync(cursor, JSON.stringify({ sessionFile: "old-session.jsonl" }));
  const runtime = Object.create(Runtimes.prototype) as {
    freshIdentityStart(
      id: string,
      params: Record<string, unknown>,
    ): Promise<{ runtimeId: string }>;
  };
  t.mock.method(
    runtime as unknown as PrivateRuntime,
    "rpc",
    async (_method: string, params: unknown) => {
      assert.equal(existsSync(cursor), false);
      assert.equal((params as { sessionFile?: string }).sessionFile, undefined);
      return { runtimeId: randomUUID() };
    },
  );
  await runtime.freshIdentityStart(id, { identityId: id });
  assert.equal(existsSync(cursor), false);
  const backups = readdirSync(directory);
  assert.equal(backups.length, 1);
  assert.match(
    readFileSync(join(directory, backups[0]!), "utf8"),
    /old-session/,
  );
});

test("具名身份恢复被游标悄悄替换：停止错会话、避开游标再新建", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-cursor-mismatch-"));
  const data = join(root, "data");
  mkdirSync(data);
  const store = new Store(join(data, "atrium.db"));
  const { agent } = store.createAgent("Atlas", root);
  assignFixture(store, agent.id);
  const profile = join(root, "profile");
  mkdirSync(profile);
  const oldFile = join(root, "old.jsonl");
  writeFileSync(oldFile, "original session\n");
  store.run(
    "UPDATE agents SET agent_directory=?,session_file=? WHERE id=?",
    profile,
    oldFile,
    agent.id,
  );
  const cursorDir = join(root, "identities");
  mkdirSync(cursorDir);
  const cursor = join(cursorDir, `${agent.id}.cursor.json`);
  writeFileSync(cursor, JSON.stringify({ sessionFile: "other-session.jsonl" }));
  const piAcp = process.env.PI_ACP_DIR;
  process.env.PI_ACP_DIR = root;
  const calls: string[] = [];
  const first = randomUUID();
  const second = randomUUID();
  t.mock.method(
    Runtimes.prototype as unknown as PrivateRuntime,
    "rpc",
    async (method: string, params: unknown) => {
      calls.push(method);
      if (method === "_pi/identity/start") {
        const supplied = (params as { sessionFile?: string }).sessionFile;
        if (supplied) return { runtimeId: first };
        assert.equal(existsSync(cursor), false);
        return { runtimeId: second };
      }
      return {};
    },
  );
  let runtimes: Runtimes;
  t.mock.method(
    Runtimes.prototype as unknown as PrivateRuntime,
    "bind",
    async (id: string, selector: { runtimeId: string }) => {
      const info: RuntimeInfo = {
        runtimeId: selector.runtimeId,
        generation: randomUUID(),
        sessionId: randomUUID(),
        sessionFile: join(
          root,
          selector.runtimeId === first ? "other.jsonl" : "new.jsonl",
        ),
        identityId: id,
        mode: "rpc",
        cwd: root,
        pid: process.pid,
        ownerPid: process.pid,
        busy: false,
        model: "fixture",
      };
      runtimes.connections.set(id, { connection: null as never, info });
      store.run(
        "UPDATE agents SET session_file=? WHERE id=?",
        info.sessionFile,
        id,
      );
    },
  );
  t.mock.method(Runtimes.prototype, "pump", async () => {});
  runtimes = new Runtimes(
    store,
    data,
    () => {},
    () => "http://127.0.0.1:4399",
    undefined,
    join(root, "desktops"),
  );
  t.after(async () => {
    if (piAcp === undefined) delete process.env.PI_ACP_DIR;
    else process.env.PI_ACP_DIR = piAcp;
    await runtimes.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await runtimes.start(agent.id);
  assert.deepEqual(
    calls.filter((call) => call.includes("identity/")),
    ["_pi/identity/start", "_pi/identity/stop", "_pi/identity/start"],
  );
  assert.equal(runtimes.connections.get(agent.id)?.info.runtimeId, second);
  assert.equal(readFileSync(oldFile, "utf8"), "original session\n");
  assert.match(store.agent(agent.id).session_reset_reason!, /新建会话/);
  assert.equal(readdirSync(cursorDir).length, 1);
});

test("新会话再报 prompt-capture：只回退一次，按普通失败处理", async (t) => {
  const { store, agent, calls, delivered } = await fixture(t, "twice");
  assert.equal(delivered.length, 2);
  assert.equal(calls.filter((method) => method === "session/new").length, 1);
  assert.match(store.failure(agent.id)!.text, /prompt-capture/);
});
