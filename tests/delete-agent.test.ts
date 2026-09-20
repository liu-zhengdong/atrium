import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createApp } from "../server/app.ts";
import { Runtimes } from "../server/runtime.ts";
import { Store } from "../server/store.ts";
import { mergeReadState } from "../web/chat/readState.ts";
import { packageRoot } from "../server/service-state.ts";

const require = createRequire(import.meta.url);
const { claimIdentity } = require("@liuser/pi-atrium/dist/identity.js") as {
  claimIdentity(
    identity: { identityId: string; agentDirectory: string },
    cwd: string,
  ): { release(): void };
};
const exec = promisify(execFile);
const transport = Runtimes.prototype as unknown as {
  rpc(method: string, params: unknown): Promise<unknown>;
};

test("删除撤销访问和唤醒，保留历史、回执、文件；名称可重用但编号不复用", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-delete-"));
  const data = join(root, "data"),
    template = join(root, "template");
  mkdirSync(template);
  writeFileSync(join(template, "settings.json"), '{"packages":[]}');
  writeFileSync(join(template, "SYSTEM.md"), "shared rules");
  t.mock.method(transport, "rpc", async () => ({ runtimes: [] }));
  t.mock.method(Runtimes.prototype, "pump", async () => {});
  t.mock.property(process, "env", {
    ...process.env,
    PI_ACP_DIR: join(root, "acp"),
  });
  const piHome = join(root, ".pi");
  const { app, store, runtimes } = await createApp({
    data,
    desktops: join(root, "desktops"),
    piHome,
  });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const created = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { name: "演示 Agent", template },
  });
  assert.equal(created.statusCode, 201);
  const agent = created.json().agent;
  const token = JSON.parse(
    readFileSync(join(data, "credentials", `${agent.id}.json`), "utf8"),
  ).token;
  const other = store.createAgent("保留 Agent", root).agent;
  const direct = store.createChat(agent.name, [agent.id], agent.id);
  const group = store.createChat("讨论组", [agent.id, other.id]);
  const a = store.send(agent.id, {
    chat_id: group.id,
    body: "我的历史发言",
    mentions: [],
  });
  const b = store.send("user", {
    chat_id: direct.id,
    body: "历史私聊",
    mentions: [],
  });
  store.readChat(agent.id, direct.id);
  store.configure(agent.id, { auto_start: true });
  const before = store.timeline(direct.id);
  const remove = (payload: Record<string, string> = { confirm: agent.ref }) =>
    app.inject({ method: "DELETE", url: `/api/agents/${agent.id}`, payload });
  assert.equal((await remove({ confirm: "a999" })).statusCode, 400);
  assert.equal((await remove({})).statusCode, 400);
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/agents/${agent.id}`,
        headers: { origin: "https://bad.example" },
        payload: { confirm: agent.ref },
      })
    ).statusCode,
    403,
  );
  assert.equal((await remove()).statusCode, 200);
  assert.equal((await remove()).statusCode, 404);
  assert(!store.authenticate(agent.id, token));
  assert.deepEqual(
    store.agents().map((a) => a.id),
    [other.id],
  );
  assert.equal(store.pending(agent.id).length, 0);
  assert(!store.schedule(Date.now() + 1e7).includes(agent.id));
  assert.equal(store.chat(direct.id).read_only, true);
  assert.equal(store.timeline(direct.id).items[0].body, before.items[0].body);
  assert.equal(store.timeline(group.id).items[0].sender_name, agent.name);
  assert(store.timeline(group.id).items[0].sender_deleted_at);
  assert.deepEqual(store.members(group.id), [other.id]);
  assert(existsSync(join(agent.agent_directory, "settings.json")));
  assert(
    existsSync(join(root, "desktops", "演示 Agent")),
    "删除身份保留专属工作目录",
  );
  assert(
    !existsSync(join(piHome, "agents", "演示 Agent")),
    "删除时摘掉名称入口",
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/agents",
        payload: { name: agent.name, template },
      })
    ).statusCode,
    409,
    "残留桌面不默默沿用",
  );
  assert.equal(
    readFileSync(join(template, "SYSTEM.md"), "utf8"),
    "shared rules",
  );
  for (const run of [
    () =>
      store.send("user", {
        chat_id: direct.id,
        body: "不该送出",
        mentions: [],
      }),
    () =>
      store.send(agent.id, { chat_id: group.id, body: "复活", mentions: [] }),
    () =>
      store.send("user", {
        chat_id: group.id,
        body: "@已删除",
        mentions: [agent.id],
      }),
    () => store.addMember(group.id, agent.id),
    () => store.createChat("不该重建", [agent.id], agent.id),
    () => store.configure(agent.id, { auto_start: true }),
    () => store.queue(agent.id, "summary", "唤醒"),
  ])
    assert.throws(run);
  const old = store.timeline(direct.id).read_state[0];
  assert.equal(old.through, b.id);
  const next = store.send("user", {
    chat_id: group.id,
    body: "继续讨论",
    mentions: [other.id],
  });
  assert(next.id > old.deleted_after!);
  assert(a.id <= old.deleted_after!);
  assert.equal(mergeReadState([], [old])[0].deleted_after, old.deleted_after);
  assert.equal(
    mergeReadState(
      [old],
      [{ ...old, deleted_at: null, deleted_after: null }],
    )[0].deleted_after,
    old.deleted_after,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/mcp/${agent.id}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      })
    ).statusCode,
    401,
  );
  await assert.rejects(runtimes!.start(agent.id), /不存在/);
  const reused = store.createAgent(agent.name, root).agent;
  assert.equal(reused.ref, "a3");
  assert.notEqual(reused.id, agent.id);
  await assert.rejects(
    exec(
      process.execPath,
      [join(packageRoot, "bin/atrium.mjs"), "run", agent.ref],
      { env: { ...process.env, ATRIUM_DATA: data }, timeout: 5000 },
    ),
    /Agent 不存在/,
  );
  const reopened = new Store(join(data, "atrium.sqlite"));
  try {
    assert(!reopened.agents().some((a) => a.id === agent.id));
    assert.equal(reopened.timeline(group.id).items[0].sender_name, agent.name);
  } finally {
    reopened.close();
  }
});

test("运行、未发现的具名占用、未知状态与并发启动均拒绝删除", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-delete-guards-"));
  const directory = join(root, "profile");
  mkdirSync(directory);
  t.mock.property(process, "env", {
    ...process.env,
    PI_ACP_DIR: join(root, "acp"),
  });
  let discoveryFails = false;
  let paused: Promise<void> | undefined;
  t.mock.method(transport, "rpc", async () => {
    if (paused) await paused;
    if (discoveryFails) throw new Error("offline");
    return { runtimes: [] };
  });
  t.mock.method(Runtimes.prototype, "pump", async () => {});
  const { app, store, runtimes } = await createApp({
    data: join(root, "data"),
    piHome: join(root, ".pi"),
  });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const agent = store.createAgent("占用样本", root).agent;
  const remove = () => runtimes!.remove(agent.id, agent.ref);
  store.run(
    "UPDATE agents SET runtime_pid=? WHERE id=?",
    process.pid,
    agent.id,
  );
  await assert.rejects(remove(), /仍在运行/);
  store.run(
    "UPDATE agents SET runtime_pid=NULL,agent_directory=? WHERE id=?",
    directory,
    agent.id,
  );
  const lease = claimIdentity(
    { identityId: agent.id, agentDirectory: directory },
    root,
  );
  try {
    await assert.rejects(remove(), /仍被占用或状态不明/);
    assert(store.agent(agent.id));
  } finally {
    lease.release();
  }
  discoveryFails = true;
  await assert.rejects(remove(), /无法确认运行状态/);
  discoveryFails = false;
  let resume!: () => void;
  paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const deleting = remove();
  await assert.rejects(runtimes!.start(agent.id), /正在接入/);
  resume();
  await deleting;
  assert.throws(() => store.agent(agent.id));
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: "/api/agents/not-an-id",
        payload: { confirm: "a1" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/agents/${randomUUID()}`,
        payload: { confirm: "a1" },
      })
    ).statusCode,
    404,
  );
});

test(
  "全局 CLI 具名启动持有占用：运行时拒绝删除，退出后允许",
  { timeout: 10000, skip: process.platform === "win32" },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "atrium-delete-cli-"));
    const profile = join(root, "profile"),
      data = join(root, "data"),
      marker = join(root, "started");
    mkdirSync(profile);
    const command = join(root, "pi-fixture");
    writeFileSync(
      command,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setTimeout(() => {}, 1200);\n`,
      { mode: 0o700 },
    );
    t.mock.property(process, "env", {
      ...process.env,
      PI_ACP_DIR: join(root, "acp"),
    });
    t.mock.method(transport, "rpc", async () => ({ runtimes: [] }));
    t.mock.method(Runtimes.prototype, "pump", async () => {});
    const { app, store, runtimes } = await createApp({
      data,
      piHome: join(root, ".pi"),
    });
    t.after(async () => {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    });
    const agent = store.createAgent("终端占用", root).agent;
    store.run(
      "UPDATE agents SET agent_directory=? WHERE id=?",
      profile,
      agent.id,
    );
    const running = exec(
      process.execPath,
      [join(packageRoot, "bin/atrium.mjs"), "run", agent.ref],
      {
        env: { ...process.env, ATRIUM_DATA: data, PI_ACP_PI_COMMAND: command },
        timeout: 6000,
      },
    );
    const { setTimeout: delay } = await import("node:timers/promises");
    try {
      for (let i = 0; i < 100 && !existsSync(marker); i++) await delay(20);
      assert(existsSync(marker));
      await assert.rejects(
        runtimes!.remove(agent.id, agent.ref),
        /仍被占用或状态不明/,
      );
    } finally {
      await running;
    }
    await runtimes!.remove(agent.id, agent.ref);
    assert.throws(() => store.agent(agent.id));
  },
);
