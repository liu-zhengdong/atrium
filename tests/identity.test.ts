import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/app.ts";
import { Store } from "../server/store.ts";
import { Runtimes } from "../server/runtime.ts";

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
  const { app, store, runtimes } = await createApp({
    data: join(root, "data"),
  });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const created = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { name: "Atlas", cwd: root, template, description: "研究" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { agent } = created.json();
  assert.equal(agent.ref, "a1");
  assert.equal(store.resolveAgentId("a1"), agent.id);
  assert(existsSync(join(agent.agent_directory, "sessions")));
  assert(!existsSync(join(agent.agent_directory, "auth.json")));
  assert.equal(
    realpathSync(join(agent.agent_directory, "SYSTEM.md")),
    join(template, "SYSTEM.md"),
  );
  const settings = JSON.parse(
    readFileSync(join(agent.agent_directory, "settings.json"), "utf8"),
  );
  assert.equal(settings.defaultModel, "fixture");
  assert(settings.packages.some((p: string) => p.includes("pi-acp")));
  const chat = store.createChat(agent.name, [agent.id], agent.id);
  const renamed = await app.inject({
    method: "PATCH",
    url: `/api/agents/${agent.id}/profile`,
    payload: { name: "Atlas 改名", description: "继续研究" },
  });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().ref, "a1");
  assert.equal(store.chat(chat.id).name, "Atlas 改名");
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
  // 旧设计的托管会话与身份配置同路径：升级保留会话与日志，身份文件并列写入
  const legacyDir = join(root, "data", "agents", legacy.id);
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "session.jsonl"), '{"type":"session"}\n');
  writeFileSync(join(legacyDir, "runtime.log"), "legacy log\n");
  const migrated = await runtimes!.promote(legacy.id, template);
  assert.equal(migrated.id, legacy.id);
  assert.equal(migrated.ref, legacy.ref);
  assert.equal(store.timeline(oldChat.id).items[0]!.body, "历史保留");
  assert.equal(
    readFileSync(join(legacyDir, "session.jsonl"), "utf8"),
    '{"type":"session"}\n',
  );
  assert.equal(readFileSync(join(legacyDir, "runtime.log"), "utf8"), "legacy log\n");
  assert(existsSync(join(legacyDir, "identity.json")));
  assert(existsSync(join(legacyDir, "settings.json")));
  assert(existsSync(join(legacyDir, "sessions")));
  await assert.rejects(
    runtimes!.promote(legacy.id, template),
    /已经是长期身份/,
  );
  // 已含 identity.json 的目录是真正的身份配置，仍拒绝覆盖
  const occupied = store.createAgent("已占用", root).agent;
  mkdirSync(join(root, "data", "agents", occupied.id), { recursive: true });
  writeFileSync(
    join(root, "data", "agents", occupied.id, "identity.json"),
    "{}",
  );
  await assert.rejects(
    runtimes!.promote(occupied.id, template),
    /身份配置目录已存在/,
  );
  assert.equal(store.agent(occupied.id).agent_directory, null);
  for (const payload of [
    { name: "../逃逸", cwd: root, template },
    { name: "Atlas 改名", cwd: root, template },
    { name: "坏目录", cwd: "/nonexistent/fixture", template },
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
  for (const ref of [
    "a0",
    "a01",
    "A2",
    "a2 OR 1=1",
    "a2\n",
    "a9999999999999999",
  ])
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
