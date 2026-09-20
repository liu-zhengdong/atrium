import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createApp } from "../server/app.ts";
import { ensureDesktopCwd, existingDirectoryPath } from "../server/agents.ts";
import { Problem, Store } from "../server/store.ts";
import { Runtimes } from "../server/runtime.ts";

const require = createRequire(import.meta.url);
const bridge = dirname(require.resolve("@liuser/pi-atrium/package.json"));

test("长期身份配置独立、引用共享资源、不复制凭据；改名与迁移保留短号及聊天", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atrium-identity-")));
  const template = join(root, "template");
  mkdirSync(template);
  writeFileSync(
    join(template, "settings.json"),
    JSON.stringify({ defaultModel: "fixture", packages: [] }),
  );
  writeFileSync(join(template, "auth.json"), "DO_NOT_COPY");
  writeFileSync(join(template, "SYSTEM.md"), "shared rules");
  t.mock.method(
    Runtimes.prototype as unknown as { rpc: () => Promise<unknown> },
    "rpc",
    async () => ({ runtimes: [] }),
  );
  t.mock.method(Runtimes.prototype, "pump", async () => {});
  const piHome = join(root, ".pi");
  const { app, store, runtimes } = await createApp({
    data: join(root, "data"),
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
    payload: { name: "Atlas", template, description: "研究" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { agent } = created.json();
  assert.equal(agent.ref, "a1");
  assert.equal(
    agent.cwd,
    realpathSync(join(root, "desktops", "Atlas")),
    "创建即分配固定桌面目录",
  );
  assert(existsSync(agent.cwd));
  assert.equal(store.resolveAgentId("a1"), agent.id);
  assert.equal(store.resolveAgentId("Atlas"), agent.id);
  assert.equal(
    realpathSync(join(piHome, "agents", "Atlas")),
    realpathSync(agent.agent_directory),
  );
  assert.equal(
    agent.agent_directory,
    join(piHome, "atrium", "agents", agent.id),
  );
  assert(existsSync(join(agent.agent_directory, "sessions")));
  assert(!existsSync(join(agent.agent_directory, "auth.json")));
  assert.equal(
    readFileSync(join(agent.agent_directory, "SYSTEM.md"), "utf8"),
    "shared rules",
  );
  assert.equal(
    lstatSync(join(agent.agent_directory, "SYSTEM.md")).isSymbolicLink(),
    false,
  );
  const settings = JSON.parse(
    readFileSync(join(agent.agent_directory, "settings.json"), "utf8"),
  );
  assert.equal(settings.defaultModel, "fixture");
  assert(settings.packages.some((p: string) => p.includes("pi-atrium")));
  const chat = store.createChat(agent.name, [agent.id], agent.id);
  const renamed = await app.inject({
    method: "PATCH",
    url: `/api/agents/${agent.id}/profile`,
    payload: { name: "Atlas 改名", description: "继续研究" },
  });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().ref, "a1");
  assert.equal(renamed.json().cwd, agent.cwd);
  assert.equal(store.chat(chat.id).name, "Atlas 改名");
  assert.equal(
    realpathSync(join(piHome, "agents", "Atlas 改名")),
    realpathSync(agent.agent_directory),
  );
  assert(!existsSync(join(piHome, "agents", "Atlas")));
  store.run("UPDATE chats SET name=? WHERE id=?", "自定义标题", chat.id);
  await app.inject({
    method: "PATCH",
    url: `/api/agents/${agent.id}/profile`,
    payload: { name: "Atlas 改名", description: "更新介绍" },
  });
  assert.equal(store.chat(chat.id).name, "自定义标题");
  assert.equal(store.createChat("重复创建", [agent.id], agent.id).id, chat.id);
  const legacy = store.createAgent("旧记录", root).agent;
  const oldChat = store.createChat("旧私聊", [legacy.id], legacy.id);
  store.send("user", { chat_id: oldChat.id, body: "历史保留", mentions: [] });
  store.run(
    "UPDATE agents SET runtime_pid=? WHERE id=?",
    process.pid,
    legacy.id,
  );
  await assert.rejects(runtimes!.promote(legacy.id, template), /正常退出旧 Pi/);
  assert.equal(store.agent(legacy.id).agent_directory, null);
  store.run("UPDATE agents SET runtime_pid=NULL WHERE id=?", legacy.id);
  const migrated = await runtimes!.promote(legacy.id, template);
  assert.equal(migrated.id, legacy.id);
  assert.equal(migrated.ref, legacy.ref);
  assert.equal(store.timeline(oldChat.id).items[0]!.body, "历史保留");
  const legacyDir = join(piHome, "atrium", "agents", legacy.id);
  assert.equal(migrated.agent_directory, legacyDir);
  assert(existsSync(join(legacyDir, "identity.json")));
  assert(existsSync(join(legacyDir, "settings.json")));
  assert(existsSync(join(legacyDir, "sessions")));
  assert.equal(
    realpathSync(join(piHome, "agents", "旧记录")),
    realpathSync(legacyDir),
  );
  await assert.rejects(
    runtimes!.promote(legacy.id, template),
    /已经是长期身份/,
  );
  // 已含 identity.json 的目录是真正的身份配置，仍拒绝覆盖
  const occupied = store.createAgent("已占用", root).agent;
  mkdirSync(join(piHome, "atrium", "agents", occupied.id), {
    recursive: true,
  });
  writeFileSync(
    join(piHome, "atrium", "agents", occupied.id, "identity.json"),
    "{}",
  );
  await assert.rejects(
    runtimes!.promote(occupied.id, template),
    /身份配置目录已存在/,
  );
  assert.equal(store.agent(occupied.id).agent_directory, null);
  mkdirSync(join(root, "desktops"), { recursive: true });
  writeFileSync(join(root, "desktops", "坏目录"), "occupied");
  mkdirSync(join(root, "desktops", "残留桌面"));
  for (const payload of [
    { name: "../逃逸", template },
    { name: "Atlas 改名", template },
    { name: "..", template },
    { name: "坏目录", template },
    { name: "残留桌面", template },
  ]) {
    const result = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload,
    });
    assert(result.statusCode >= 400, result.body);
  }
  assert.equal(store.agents().length, 3);
});

test("身份短号原地迁移、持久不复用；坏引用拒绝", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-agent-refs-")),
    path = join(root, "db.sqlite");
  let store = new Store(path);
  const a = store.createAgent("第一位", root).agent;
  store.db.exec("DROP TRIGGER agents_assign_ref; DROP TABLE agent_refs");
  store.close();
  store = new Store(path);
  assert.equal(store.agent(a.id).ref, "a1");
  store.run("DELETE FROM agents WHERE id=?", a.id);
  assert.equal(store.createAgent("第二位", root).agent.ref, "a2");
  assert.equal(store.resolveAgentId("a2\n"), store.resolveAgentId("a2"));
  for (const ref of ["a0", "a01", "A2", "a2 OR 1=1", "a9999999999999999"])
    assert.throws(() => store.resolveAgentId(ref));
  store.close();
  store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(store.one<{ n: number }>("SELECT total_changes() AS n")!.n, 0);
  assert.equal(store.agents()[0]!.ref, "a2");
});

test("工作目录丢失时回落到桌面目录；仍在则保持", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atrium-cwd-")));
  const desktops = join(root, "desktops");
  mkdirSync(desktops, { recursive: true });
  const store = new Store(join(root, "atrium.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const gone = join(root, "missing-workspace");
  const { agent } = store.createAgent("Atlas", gone);

  const custom = mkdtempSync(join(root, "custom-"));
  const customCwd = existingDirectoryPath(custom);
  store.run("UPDATE agents SET cwd=? WHERE id=?", custom, agent.id);
  assert.equal(
    ensureDesktopCwd(store, desktops, store.agent(agent.id)),
    customCwd,
    "已有目录不迁回桌面",
  );
  assert.equal(store.agent(agent.id).cwd, customCwd);

  store.run("UPDATE agents SET cwd=? WHERE id=?", gone, agent.id);
  const desktop = ensureDesktopCwd(store, desktops, store.agent(agent.id));
  assert.equal(desktop, existingDirectoryPath(join(desktops, "Atlas")));
  assert.equal(store.agent(agent.id).cwd, desktop);
  assert(existsSync(desktop));

  store.run("UPDATE agents SET cwd=? WHERE id=?", gone, agent.id);
  rmSync(desktop, { recursive: true, force: true });
  writeFileSync(join(desktops, "Atlas"), "not a directory");
  assert.throws(
    () => ensureDesktopCwd(store, desktops, store.agent(agent.id)),
    (error: unknown) =>
      error instanceof Problem &&
      error.statusCode === 409 &&
      error.message.includes("无法创建工作目录"),
  );
  assert.equal(store.agent(agent.id).cwd, gone, "回落失败时不改记录");
});

test("已有 cwd 大小写不符时写回磁盘真实拼写", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atrium-cwd-case-")));
  const desktops = join(root, "desktops");
  mkdirSync(join(desktops, "AtriumDesk", "Agent"), { recursive: true });
  const store = new Store(join(root, "atrium.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const actual = existingDirectoryPath(join(desktops, "AtriumDesk", "Agent"));
  const folded = actual
    .split("/")
    .map((part, index, parts) =>
      index === parts.length - 2
        ? part.toLowerCase()
        : index === parts.length - 1
          ? part.toLowerCase()
          : part,
    )
    .join("/");
  if (folded === actual) {
    t.skip("当前文件系统区分大小写，跳过拼写纠正断言");
    return;
  }
  const { agent } = store.createAgent("CaseAgent", folded);
  assert.equal(
    ensureDesktopCwd(store, desktops, store.agent(agent.id)),
    actual,
    "启动前把 cwd 纠正为磁盘真实大小写",
  );
  assert.equal(store.agent(agent.id).cwd, actual);
});

test("启动时把丢失的工作目录写回桌面并交给 Pi", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atrium-start-cwd-")));
  const desktops = join(root, "desktops");
  let started: { cwd?: string } = {};
  t.mock.method(
    Runtimes.prototype as unknown as {
      rpc: (method: string, params: unknown) => Promise<unknown>;
    },
    "rpc",
    async (method: string, params: unknown) => {
      if (method === "_pi/identity/start") {
        started = params as { cwd?: string };
        return { runtimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
      }
      return { runtimes: [] };
    },
  );
  t.mock.method(
    Runtimes.prototype as unknown as { bind: () => Promise<void> },
    "bind",
    async () => {},
  );
  t.mock.method(Runtimes.prototype, "pump", async () => {});
  const template = join(root, "template");
  mkdirSync(template);
  writeFileSync(
    join(template, "settings.json"),
    JSON.stringify({ defaultModel: "fixture", packages: [] }),
  );
  const { app, store } = await createApp({
    data: join(root, "data"),
    desktops,
    piHome: join(root, ".pi"),
  });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const created = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { name: "Atlas", template },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { agent } = created.json();
  const gone = join(root, "gone");
  store.run("UPDATE agents SET cwd=? WHERE id=?", gone, agent.id);
  const response = await app.inject({
    method: "POST",
    url: `/api/agents/${agent.id}/start`,
  });
  assert.equal(response.statusCode, 200, response.body);
  const desktop = existingDirectoryPath(join(desktops, "Atlas"));
  assert.equal(store.agent(agent.id).cwd, desktop);
  assert.equal(started.cwd, desktop);
});

test("启动已有身份时改写缺失的合集包路径，再交给 Pi", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atrium-start-pkg-")));
  const stale = join(root, "node_modules/@liuser/pi-acp");
  let agentDir = "";
  let started = false;
  t.mock.method(
    Runtimes.prototype as unknown as {
      rpc: (method: string, params: unknown) => Promise<unknown>;
    },
    "rpc",
    async (method: string) => {
      if (method === "_pi/identity/start") {
        started = true;
        const settings = JSON.parse(
          readFileSync(join(agentDir, "settings.json"), "utf8"),
        ) as { packages: string[] };
        assert.equal(settings.packages.includes(stale), false);
        assert.equal(settings.packages.includes(bridge), true);
        return { runtimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
      }
      return { runtimes: [] };
    },
  );
  t.mock.method(
    Runtimes.prototype as unknown as { bind: () => Promise<void> },
    "bind",
    async () => {},
  );
  t.mock.method(Runtimes.prototype, "pump", async () => {});
  const template = join(root, "template");
  mkdirSync(template);
  writeFileSync(
    join(template, "settings.json"),
    JSON.stringify({ defaultModel: "fixture", packages: [] }),
  );
  const { app } = await createApp({
    data: join(root, "data"),
    desktops: join(root, "desktops"),
    piHome: join(root, ".pi"),
  });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const created = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { name: "Atlas", template },
  });
  assert.equal(created.statusCode, 201, created.body);
  agentDir = created.json().agent.agent_directory as string;
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultModel: "fixture",
      packages: [stale, join(root, "other-ext")],
    }) + "\n",
  );
  const response = await app.inject({
    method: "POST",
    url: `/api/agents/${created.json().agent.id}/start`,
  });
  assert.equal(started, true);
  assert.equal(response.statusCode, 200, response.body);
  const settings = JSON.parse(
    readFileSync(join(agentDir, "settings.json"), "utf8"),
  ) as { packages: string[] };
  assert.deepEqual(settings.packages, [join(root, "other-ext"), bridge]);
});
