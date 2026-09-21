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
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp } from "../server/app.ts";
import { createAgent } from "../server/agents.ts";
import { createMcp } from "../server/mcp.ts";
import { Store } from "../server/store.ts";
import { Runtimes } from "../server/runtime.ts";

function templateWithVault(root: string) {
  const template = join(root, "template");
  const vault = join(root, "vault");
  mkdirSync(join(vault, "Library"), { recursive: true });
  mkdirSync(template);
  writeFileSync(
    join(template, "settings.json"),
    JSON.stringify({ defaultModel: "fixture", packages: [] }),
  );
  writeFileSync(join(template, "auth.json"), "DO_NOT_COPY");
  writeFileSync(join(template, "SYSTEM.md"), "shared rules");
  writeFileSync(join(template, "AGENTS.md"), "tune me");
  mkdirSync(join(vault, "self-evolution"));
  writeFileSync(join(vault, "USER.md"), "user model");
  writeFileSync(join(vault, "USER-Evolution.md"), "history");
  writeFileSync(join(vault, "self-evolution.md"), "evolution protocol");
  writeFileSync(join(vault, "self-evolution-Evolution.md"), "protocol history");
  writeFileSync(
    join(vault, "self-evolution", "user-understanding.md"),
    "sub note",
  );
  writeFileSync(join(vault, "密钥管理.md"), "not copied");
  writeFileSync(join(vault, "Library", "noise.md"), "not copied");
  writeFileSync(
    join(template, "notes.json"),
    JSON.stringify({ directory: vault, maxContextBytes: 99 }),
  );
  return template;
}

test("活配置自有规则和笔记；fork 后互不影响；不拷凭据和金库", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atrium-fork-")));
  const template = templateWithVault(root);
  t.mock.method(
    Runtimes.prototype as unknown as { rpc: () => Promise<unknown> },
    "rpc",
    async () => ({ runtimes: [] }),
  );
  t.mock.method(Runtimes.prototype, "pump", async () => {});
  const piHome = join(root, ".pi");
  const { app, store } = await createApp({
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
    payload: { name: "林岚", template },
  });
  assert.equal(created.statusCode, 201, created.body);
  const first = created.json().agent;
  assert.equal(
    realpathSync(join(piHome, "agents", "林岚")),
    realpathSync(first.agent_directory),
  );
  assert.equal(
    first.agent_directory,
    join(piHome, "atrium", "agents", first.id),
  );
  assert.equal(
    readFileSync(join(first.agent_directory, "SYSTEM.md"), "utf8"),
    "shared rules",
  );
  assert.equal(
    lstatSync(join(first.agent_directory, "SYSTEM.md")).isSymbolicLink(),
    false,
  );
  assert(!existsSync(join(first.agent_directory, "auth.json")));
  const notes = JSON.parse(
    readFileSync(join(first.agent_directory, "notes.json"), "utf8"),
  );
  assert.equal(notes.directory, join(first.agent_directory, "notes"));
  assert.equal(notes.maxContextBytes, 99);
  assert.equal(
    readFileSync(join(notes.directory, "USER.md"), "utf8"),
    "user model",
  );
  assert.equal(
    readFileSync(join(notes.directory, "self-evolution.md"), "utf8"),
    "evolution protocol",
  );
  assert.equal(
    readFileSync(join(notes.directory, "self-evolution-Evolution.md"), "utf8"),
    "protocol history",
  );
  assert.equal(
    readFileSync(
      join(notes.directory, "self-evolution", "user-understanding.md"),
      "utf8",
    ),
    "sub note",
  );
  assert(!existsSync(join(notes.directory, "密钥管理.md")));
  assert(!existsSync(join(notes.directory, "Library")));
  writeFileSync(join(first.agent_directory, "SYSTEM.md"), "tuned by 林岚");
  const forked = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { name: "沈默", source: first.name },
  });
  assert.equal(forked.statusCode, 201, forked.body);
  const second = forked.json().agent;
  assert.equal(second.ref, "a2");
  assert.equal(
    readFileSync(join(second.agent_directory, "SYSTEM.md"), "utf8"),
    "tuned by 林岚",
  );
  writeFileSync(join(second.agent_directory, "SYSTEM.md"), "tuned by 沈默");
  assert.equal(
    readFileSync(join(first.agent_directory, "SYSTEM.md"), "utf8"),
    "tuned by 林岚",
  );
  assert.equal(
    readFileSync(
      join(join(second.agent_directory, "notes"), "USER.md"),
      "utf8",
    ),
    "user model",
  );
  writeFileSync(
    join(second.agent_directory, "notes", "USER.md"),
    "沈默的用户理解",
  );
  assert.equal(
    readFileSync(join(first.agent_directory, "notes", "USER.md"), "utf8"),
    "user model",
  );
  assert.equal(store.agents().length, 2);
  const clash = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { name: "沈默", source: "builtin" },
  });
  assert.equal(clash.statusCode, 409);
  const bad = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { name: "第三者", source: "/tmp/not-an-agent" },
  });
  assert.equal(bad.statusCode, 400);
});

test("Agent 从名单 fork；预置不进聊天名册；不泄露目录", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atrium-fork-mcp-")));
  const template = templateWithVault(root);
  const data = join(root, "data");
  const desktops = join(root, "desktops");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const store = new Store(join(data, "atrium.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const previous = process.env.ATRIUM_PI_TEMPLATE;
  process.env.ATRIUM_PI_TEMPLATE = template;
  t.after(() => {
    if (previous === undefined) delete process.env.ATRIUM_PI_TEMPLATE;
    else process.env.ATRIUM_PI_TEMPLATE = previous;
  });
  const piHome = join(root, ".pi");
  const first = createAgent(store, data, "林岚", desktops, {
    template,
    piHome,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const server = createMcp(
    store,
    first.id,
    () => {},
    () => ({ online: false, busy: null }),
    { data, desktops, piHome },
  );
  await server.connect(serverSide);
  const client = new Client({ name: "fork-test", version: "1" });
  await client.connect(clientSide);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert(!result.isError, JSON.stringify(result));
    return JSON.parse((result.content as { text: string }[])[0].text);
  };
  const reject = async (name: string, args: Record<string, unknown>) =>
    assert((await client.callTool({ name, arguments: args })).isError);
  const peers = await call("list_agents", {});
  assert.equal(
    peers.items.some((item: { id: string }) => item.id === "builtin"),
    false,
  );
  const sources = await call("list_fork_sources", {});
  assert.deepEqual(
    sources.items.map((item: { id: string; tag: string }) => [
      item.id,
      item.tag,
    ]),
    [
      ["builtin", "内置"],
      [first.name, "已有"],
    ],
  );
  assert(!JSON.stringify(sources).includes(root), "招募名单不泄露目录");
  const created = await call("fork_agent", {
    name: "沈默",
    source: first.name,
  });
  assert.equal(created.id, "a2");
  assert.equal(created.name, "沈默");
  assert.equal(
    store.agent(store.resolveAgentId("a2")).agent_directory !== null,
    true,
  );
  const builtin = await call("fork_agent", { name: "内置来的" });
  assert.equal(builtin.id, "a3");
  await reject("fork_agent", { name: "沈默", source: first.name });
  await reject("fork_agent", {
    name: "路径",
    source: template,
  });
  const filtered = await call("list_fork_sources", { query: "沈默" });
  assert.deepEqual(
    filtered.items.map((item: { name: string }) => item.name),
    ["沈默"],
  );
});
