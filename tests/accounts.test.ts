import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  Accounts,
  modePlan,
  shouldRecover,
  shouldRefresh,
  type AuthFile,
  type Mode,
} from "../server/accounts.ts";
import { Store, Problem } from "../server/store.ts";
import { TraceStore } from "../server/trace.ts";
import { createApp } from "../server/app.ts";

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-accounts-"));
  const template = join(dir, "template");
  mkdirSync(template);
  writeFileSync(join(template, "auth.json"), "{}\n", { mode: 0o600 });
  process.env.ATRIUM_PI_TEMPLATE = template;
  const store = new Store(join(dir, "atrium.sqlite"));
  const agent = store.createAgent("试验身份", dir).agent;
  const agentDirectory = join(dir, "identity");
  mkdirSync(agentDirectory);
  store.run(
    "UPDATE agents SET agent_directory=? WHERE id=?",
    agentDirectory,
    agent.id,
  );
  return {
    dir,
    store,
    agent,
    agentDirectory,
    accounts: new Accounts(store, dir),
  };
};

test("credential mode plan covers every file state and target combination", () => {
  const states: AuthFile[] = ["missing", "link", "empty", "content"];
  const modes: Mode[] = ["shared", "assigned"];
  const plans = states.flatMap((state) =>
    modes.flatMap((target) =>
      modes.map((previous) => modePlan(state, target, previous)),
    ),
  );
  assert.equal(plans.length, 16);
  for (const previous of modes) {
    assert.equal(modePlan("content", "shared", previous), "backup-link");
    assert.equal(modePlan("link", "assigned", previous), "write");
    assert.equal(modePlan("empty", "shared", previous), "link");
  }
  assert.equal(modePlan("content", "assigned", "shared"), "backup-write");
  assert.equal(modePlan("content", "assigned", "assigned"), "unchanged");
});

test("refresh uses 30-minute threshold; recovery adopts only a newer OAuth expiry", () => {
  const now = 1_000_000_000;
  assert.equal(shouldRefresh(null, now), false);
  assert.equal(shouldRefresh(now + 30 * 60_000, now), false);
  assert.equal(shouldRefresh(now + 30 * 60_000 - 1, now), true);
  const stored = {
    type: "oauth" as const,
    access: "old",
    refresh: "old",
    expires: now,
  };
  assert.equal(shouldRecover({ ...stored, expires: now + 1 }, stored), true);
  assert.equal(shouldRecover({ ...stored, expires: now }, stored), false);
  assert.equal(shouldRecover({ type: "api_key", key: "x" }, stored), false);
});

test("assigned files are isolated; bad assignments and real-file mode switch preserve originals", () => {
  const { store, agent, agentDirectory, accounts } = fixture();
  const first = accounts.add("deepseek", "primary", "SENSITIVE_KEY_FIRST").id;
  const second = accounts.add("deepseek", "second", "SENSITIVE_KEY_SECOND").id;
  const file = join(agentDirectory, "auth.json");
  writeFileSync(
    file,
    JSON.stringify({ deepseek: { type: "api_key", key: "PRIVATE_LOGIN" } }),
  );
  assert.throws(
    () => accounts.assign("missing", first),
    (error) => error instanceof Problem && error.statusCode === 404,
  );
  assert.throws(
    () => accounts.assign(agent.id, "k987654"),
    (error) => error instanceof Problem && error.statusCode === 404,
  );
  const assignment = accounts.assign(agent.id, first);
  assert.equal(assignment.mode, "assigned");
  assert.ok(assignment.preserved);
  assert.equal(
    JSON.parse(readFileSync(assignment.preserved!, "utf8")).deepseek.key,
    "PRIVATE_LOGIN",
  );
  assert.equal(accounts.credentialMode(agent.id), "assigned");
  assert.equal(
    JSON.parse(readFileSync(file, "utf8")).deepseek.key,
    "SENSITIVE_KEY_FIRST",
  );
  assert.throws(
    () => accounts.assign(agent.id, second),
    (error) => error instanceof Problem && error.statusCode === 409,
  );
  assert.deepEqual(
    accounts.list().map(({ id, assigned }) => [id, assigned]),
    [
      [first, [agent.ref]],
      [second, []],
    ],
  );
  const preserved = accounts.switchMode(agent.id, "shared");
  assert.ok(preserved.preserved);
  assert.equal(
    JSON.parse(readFileSync(preserved.preserved!, "utf8")).deepseek.key,
    "SENSITIVE_KEY_FIRST",
  );
  assert.equal(lstatSync(file).isSymbolicLink(), true);
  assert.equal(readFileSync(file, "utf8"), "{}\n");
  assert.equal(accounts.list()[0]?.name, "primary");
  assert.equal(
    JSON.stringify(accounts.list()).includes("SENSITIVE_KEY"),
    false,
  );
  accounts.remove(first);
  assert.equal(accounts.list().length, 1);
  store.close();
});

test("offline OAuth refresh is adopted from the newest assigned identity before redistribution", async () => {
  const { dir, store, agent, agentDirectory, accounts } = fixture();
  const peer = store.createAgent("同伴", dir).agent;
  const peerDirectory = join(dir, "peer");
  mkdirSync(peerDirectory);
  store.run(
    "UPDATE agents SET agent_directory=? WHERE id=?",
    peerDirectory,
    peer.id,
  );
  const number = Number(
    store.run(
      "INSERT INTO accounts(provider,name,type,expires) VALUES(? ,? ,'oauth',?)",
      "openai-codex",
      "OAuth",
      Date.now() - 1000,
    ).lastInsertRowid,
  );
  const ref = `k${number}`;
  const old = {
    type: "oauth",
    access: "old-access",
    refresh: "old-refresh",
    expires: Date.now() - 1000,
  };
  mkdirSync(join(accounts.root, ref));
  writeFileSync(
    join(accounts.root, ref, "auth.json"),
    JSON.stringify({ "openai-codex": old }),
    { mode: 0o600 },
  );
  accounts.assign(agent.id, ref);
  accounts.assign(peer.id, ref);
  const latest = {
    ...old,
    access: "new-access",
    refresh: "new-refresh",
    expires: Date.now() + 60 * 60_000,
  };
  writeFileSync(
    join(agentDirectory, "auth.json"),
    JSON.stringify({ "openai-codex": latest }),
    { mode: 0o600 },
  );
  await accounts.refresh();
  for (const file of [
    join(accounts.root, ref, "auth.json"),
    join(agentDirectory, "auth.json"),
    join(peerDirectory, "auth.json"),
  ])
    assert.deepEqual(
      JSON.parse(readFileSync(file, "utf8"))["openai-codex"],
      latest,
    );
  assert.equal(accounts.list()[0]?.status, "ready");
  store.close();
});

test("Antigravity sidecar is required, copied and recovered with a newer credential", async () => {
  const { dir, store, agent, agentDirectory, accounts } = fixture();
  const old = {
    type: "oauth",
    access: "old",
    refresh: "old",
    expires: Date.now() - 1000,
  };
  const number = Number(
    store.run(
      "INSERT INTO accounts(provider,name,type,expires) VALUES(? ,? ,'oauth',?)",
      "antigravity",
      "Plugin",
      old.expires,
    ).lastInsertRowid,
  );
  const ref = `k${number}`,
    source = join(accounts.root, ref);
  mkdirSync(source);
  writeFileSync(
    join(source, "auth.json"),
    JSON.stringify({ antigravity: old }),
    { mode: 0o600 },
  );
  assert.throws(
    () => accounts.assign(agent.id, ref),
    (error) => error instanceof Problem && error.statusCode === 409,
  );
  const sidecar = {
    version: 1,
    accounts: { test: { ...old, accountId: "test" } },
    activeAccountId: "test",
  };
  writeFileSync(
    join(source, "antigravity-accounts.json"),
    JSON.stringify(sidecar),
    { mode: 0o600 },
  );
  accounts.assign(agent.id, ref);
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(agentDirectory, "antigravity-accounts.json"), "utf8"),
    ),
    sidecar,
  );
  const latest = {
    ...old,
    access: "new",
    refresh: "new",
    expires: Date.now() + 60 * 60_000,
  };
  writeFileSync(
    join(agentDirectory, "auth.json"),
    JSON.stringify({ antigravity: latest }),
    { mode: 0o600 },
  );
  sidecar.accounts.test = { ...latest, accountId: "test" };
  writeFileSync(
    join(agentDirectory, "antigravity-accounts.json"),
    JSON.stringify(sidecar),
    { mode: 0o600 },
  );
  await accounts.refresh();
  assert.deepEqual(
    JSON.parse(readFileSync(join(source, "antigravity-accounts.json"), "utf8")),
    sidecar,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(source, "auth.json"), "utf8")).antigravity,
    latest,
  );
  store.close();
});

test("account HTTP responses omit credentials even on malformed stored JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-account-http-"));
  const { app, store } = await createApp({
    data: dir,
    runtime: false,
    piHome: dir,
    desktops: dir,
  });
  const key = "SECRET_HTTP_ERROR_VALUE";
  const headers = { host: "127.0.0.1" };
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers,
      payload: { provider: "deepseek", name: "http", key },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.body.includes(key), false);
    const list = await app.inject({
      method: "GET",
      url: "/api/accounts",
      headers,
    });
    assert.equal(list.body.includes(key), false);
    const id = created.json().id as string;
    writeFileSync(
      join(dir, "accounts", id, "auth.json"),
      `{ "deepseek": "${key}`,
    );
    const agent = store.createAgent("测试", dir).agent;
    const directory = join(dir, "identity");
    mkdirSync(directory);
    store.run(
      "UPDATE agents SET agent_directory=? WHERE id=?",
      directory,
      agent.id,
    );
    const bad = await app.inject({
      method: "POST",
      url: `/api/assign/${agent.ref}`,
      headers,
      payload: { account: id },
    });
    assert.equal(bad.statusCode, 500);
    assert.equal(bad.body.includes(key), false);
  } finally {
    await app.close();
  }
});

test("API and error output never echo supplied keys", async () => {
  const { store, accounts } = fixture();
  const key = "UNIQUE_SECRET_SHOULD_NEVER_SURFACE";
  const result = accounts.add("deepseek", "test", key);
  const agentId = store.agents()[0]!.id;
  accounts.assign(agentId, result.id);
  const traces = new TraceStore(store, (agent, text) =>
    accounts.redact(agent, text),
  );
  traces.ingest(agentId, {
    runtimeId: randomUUID(),
    generation: randomUUID(),
    sessionId: randomUUID(),
    gap: false,
    hasMore: false,
    nextAfter: 1,
    items: [
      {
        seq: 1,
        at: Date.now(),
        kind: "message",
        text: `provider error: ${key}`,
      },
    ],
  });
  assert.equal(
    JSON.stringify(store.all("SELECT * FROM trace_actions")).includes(key),
    false,
  );
  const outputs: unknown[] = [
    result,
    accounts.list(),
    accounts.rename(result.id, "renamed"),
    accounts.switchMode(agentId),
  ];
  try {
    accounts.assign("nonexistent", result.id);
  } catch (error) {
    outputs.push(String(error));
  }
  assert.equal(JSON.stringify(outputs).includes(key), false);
  assert.equal(
    accounts.redact(agentId, `provider error: ${key}`),
    "provider error: [凭据已隐藏]",
  );
  accounts.remove(result.id);
  assert.equal(
    accounts.redact(agentId, `old error: ${key}`).includes(key),
    false,
  );
  store.close();
});
