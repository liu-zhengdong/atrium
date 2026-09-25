import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
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
import { classifyRefreshError } from "../server/account-error.mjs";
import { AccountFiles } from "../server/account-files.ts";
import { AccountRefresh } from "../server/account-refresh.ts";
import { AccountLogin } from "../server/account-login.ts";
import { ProviderDirectory } from "../server/provider-directory.ts";

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

test("unfinished OAuth login stays a login error across service restart and refresh", async () => {
  const { dir, store } = fixture();
  const number = Number(
    store.run(
      "INSERT INTO accounts(provider,name,type,status) VALUES('openai-codex','cancelled','oauth','pending')",
    ).lastInsertRowid,
  );
  const directory = join(dir, "accounts", `k${number}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "auth.json"), "{}", { mode: 0o600 });
  const restarted = new Accounts(store, dir);
  const row = restarted.list().find((account) => account.id === `k${number}`);
  assert.equal(row?.status, "error");
  assert.equal(row?.last_error, "登录未完成");
  await restarted.refresh();
  assert.equal(
    restarted.list().find((account) => account.id === `k${number}`)?.last_error,
    "登录未完成",
  );
  assert.equal(readFileSync(join(directory, "auth.json"), "utf8"), "{}");
  store.close();
});

test("same-provider assignment replacement is one call and failure preserves the old assignment", () => {
  const { store, agent, agentDirectory, accounts } = fixture();
  const old = accounts.add("deepseek", "old", "OLD_KEY").id;
  const next = accounts.add("deepseek", "new", "NEW_KEY").id;
  accounts.assign(agent.id, old);
  const target = join(accounts.root, next, "auth.json");
  writeFileSync(target, "{broken", { mode: 0o600 });
  assert.throws(() => accounts.assign(agent.id, next, true));
  assert.deepEqual(accounts.switchMode(agent.id).assigned, [
    { provider: "deepseek", account: old },
  ]);
  assert.equal(
    JSON.parse(readFileSync(join(agentDirectory, "auth.json"), "utf8")).deepseek
      .key,
    "OLD_KEY",
  );
  writeFileSync(
    target,
    JSON.stringify({ deepseek: { type: "api_key", key: "NEW_KEY" } }),
    { mode: 0o600 },
  );
  store.run(`CREATE TRIGGER deny_swap BEFORE UPDATE ON account_assignments
    BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
  assert.throws(() => accounts.assign(agent.id, next, true), /blocked/);
  assert.deepEqual(accounts.switchMode(agent.id).assigned, [
    { provider: "deepseek", account: old },
  ]);
  assert.equal(
    JSON.parse(readFileSync(join(agentDirectory, "auth.json"), "utf8")).deepseek
      .key,
    "OLD_KEY",
  );
  store.run("DROP TRIGGER deny_swap");
  assert.deepEqual(accounts.assign(agent.id, next, true), {
    mode: "assigned",
    account: next,
    preserved: null,
  });
  assert.deepEqual(accounts.switchMode(agent.id).assigned, [
    { provider: "deepseek", account: next },
  ]);
  assert.equal(
    JSON.parse(readFileSync(join(agentDirectory, "auth.json"), "utf8")).deepseek
      .key,
    "NEW_KEY",
  );
  assert.deepEqual(accounts.list().find((a) => a.id === old)?.assigned, []);
  store.close();
});

test("shared mode is rejected without disturbing an assignment", () => {
  const { store, agent, agentDirectory, accounts } = fixture();
  const old = accounts.add("deepseek", "old", "OLD_KEY").id;
  accounts.assign(agent.id, old);
  assert.throws(
    () => accounts.switchMode(agent.id, "shared"),
    /共享个人 Pi 登录已停用/,
  );
  assert.equal(accounts.switchMode(agent.id).mode, "assigned");
  assert.equal(
    lstatSync(join(agentDirectory, "auth.json")).isSymbolicLink(),
    false,
  );
  store.close();
});

test("cancelled relogin before worker starts cannot publish staged credentials", async () => {
  const { store, accounts } = fixture();
  const number = Number(
    store.run(
      "INSERT INTO accounts(provider,name,type,status) VALUES('openai-codex','cancel','oauth','error')",
    ).lastInsertRowid,
  );
  const files = new AccountFiles(store, accounts.root);
  files.save(
    {
      number,
      provider: "openai-codex",
      name: "cancel",
      type: "oauth",
      status: "error",
      expires: null,
      last_error: null,
    },
    {
      type: "oauth",
      access: "OLD",
      refresh: "OLD",
      expires: Date.now() - 1000,
    },
  );
  let finish!: () => void;
  const login = new AccountLogin(store, files, {
    run: async () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  let published = false;
  const before = accounts.list();
  login.relogin(number, () => {
    published = true;
  });
  login.cancel(number);
  assert.deepEqual(accounts.list(), before);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(published, false);
  assert.deepEqual(accounts.list(), before);
  store.close();
});

test("cancelling a first OAuth login removes its row and directory even when the worker settles later", async () => {
  const { store, accounts } = fixture();
  const files = new AccountFiles(store, accounts.root);
  let finish!: () => void;
  const worker = {
    run: async () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  };
  const login = new AccountLogin(
    store,
    files,
    worker,
    new ProviderDirectory({
      list: async () => [
        {
          id: "openai-codex",
          name: "OpenAI Codex",
          methods: ["oauth"],
          packagePath: null,
        },
      ],
    }),
  );
  const before = accounts.list();
  const { id } = await login.login("openai-codex", "临时账号");
  assert.equal(accounts.list().length, before.length + 1);
  login.cancel(Number(id.slice(1)));
  assert.deepEqual(accounts.list(), before);
  assert.equal(existsSync(join(accounts.root, id)), false);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(accounts.list(), before);
  store.close();
});

test("cancelling a relogin retains a ready account and credential", async () => {
  const { store, accounts } = fixture();
  const files = new AccountFiles(store, accounts.root);
  const number = Number(
    store.run(
      "INSERT INTO accounts(provider,name,type,status,expires) VALUES('openai-codex','ready','oauth','ready',12345)",
    ).lastInsertRowid,
  );
  const row = store.one<import("../server/account-files.ts").Row>(
    "SELECT * FROM accounts WHERE number=?",
    number,
  )!;
  files.save(row, {
    type: "oauth",
    access: "OLD",
    refresh: "OLD",
    expires: 12345,
  });
  const before = accounts.list();
  const original = readFileSync(
    join(accounts.root, `k${number}`, "auth.json"),
    "utf8",
  );
  let finish!: () => void;
  const login = new AccountLogin(store, files, {
    run: async () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  login.relogin(number, () => {
    throw new Error("不得分发");
  });
  login.cancel(number);
  assert.deepEqual(accounts.list(), before);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(accounts.list(), before);
  assert.equal(
    readFileSync(join(accounts.root, `k${number}`, "auth.json"), "utf8"),
    original,
  );
  store.close();
});

test("relogin keeps existing OAuth assignments on failure and distributes the successful credential", async () => {
  const { store, agent, agentDirectory, accounts } = fixture();
  const number = Number(
    store.run(
      "INSERT INTO accounts(provider,name,type,status) VALUES('openai-codex','oauth','oauth','error')",
    ).lastInsertRowid,
  );
  const ref = `k${number}`;
  const files = new AccountFiles(store, accounts.root);
  files.save(
    {
      number,
      provider: "openai-codex",
      name: "oauth",
      type: "oauth",
      status: "error",
      expires: null,
      last_error: null,
    },
    {
      type: "oauth",
      access: "OLD",
      refresh: "OLD",
      expires: Date.now() - 1000,
    },
  );
  accounts.assign(agent.id, ref);
  const old = readFileSync(join(agentDirectory, "auth.json"), "utf8");
  const fail = new AccountLogin(store, files, {
    run: async () => {
      throw new Error("cancelled");
    },
  });
  fail.relogin(number, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(readFileSync(join(agentDirectory, "auth.json"), "utf8"), old);
  assert.deepEqual(accounts.switchMode(agent.id).assigned, [
    { provider: "openai-codex", account: ref },
  ]);
  const refresh = new AccountRefresh(store, files, {
    run: async () => {},
    close: () => {},
  });
  const login = new AccountLogin(store, files, {
    run: async (_row, _operation, _callback, directory) => {
      writeFileSync(
        join(directory!, "auth.json"),
        JSON.stringify({
          "openai-codex": {
            type: "oauth",
            access: "NEW",
            refresh: "NEW",
            expires: Date.now() + 3600_000,
          },
        }),
        { mode: 0o600 },
      );
    },
  });
  login.relogin(number, () =>
    refresh.distributeAccount({
      number,
      provider: "openai-codex",
      name: "oauth",
      type: "oauth",
      status: "ready",
      expires: null,
      last_error: null,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    JSON.parse(readFileSync(join(agentDirectory, "auth.json"), "utf8"))[
      "openai-codex"
    ].access,
    "NEW",
  );
  assert.deepEqual(accounts.switchMode(agent.id).assigned, [
    { provider: "openai-codex", account: ref },
  ]);
  store.close();
});

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
  const authBeforeRetry = readFileSync(file, "utf8");
  store.run(
    "CREATE TRIGGER deny_retry BEFORE UPDATE ON account_assignments BEGIN SELECT RAISE(ABORT, 'retry wrote assignment'); END",
  );
  assert.deepEqual(accounts.assign(agent.id, first), {
    mode: "assigned",
    account: first,
    preserved: null,
    alreadyAssigned: true,
  });
  assert.equal(readFileSync(file, "utf8"), authBeforeRetry);
  store.run("DROP TRIGGER deny_retry");
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
  assert.throws(
    () => accounts.switchMode(agent.id, "shared"),
    /共享个人 Pi 登录已停用/,
  );
  assert.equal(lstatSync(file).isSymbolicLink(), false);
  assert.equal(accounts.list()[0]?.name, "primary");
  assert.equal(
    JSON.stringify(accounts.list()).includes("SENSITIVE_KEY"),
    false,
  );
  accounts.remove(first);
  assert.equal(accounts.list().length, 1);
  store.close();
});

test("assigning a second provider keeps the earlier assigned credential", () => {
  const { store, agent, agentDirectory, accounts } = fixture();
  const deepseek = accounts.add("deepseek", "first", "DEEPSEEK_KEY").id;
  const openrouter = accounts.add("openrouter", "second", "OPENROUTER_KEY").id;
  accounts.assign(agent.id, deepseek);
  accounts.assign(agent.id, openrouter);
  assert.deepEqual(
    JSON.parse(readFileSync(join(agentDirectory, "auth.json"), "utf8")),
    {
      deepseek: { type: "api_key", key: "DEEPSEEK_KEY" },
      openrouter: { type: "api_key", key: "OPENROUTER_KEY" },
    },
  );
  assert.deepEqual(accounts.switchMode(agent.id), {
    mode: "assigned",
    assigned: [
      { provider: "deepseek", account: deepseek },
      { provider: "openrouter", account: openrouter },
    ],
  });
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

test("assign HTTP replaces one provider in one request and rolls back failed replacements", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-account-swap-"));
  const { app, store } = await createApp({
    auth: false,
    data: dir,
    runtime: false,
    piHome: dir,
    desktops: dir,
  });
  const headers = { host: "127.0.0.1" };
  try {
    const agent = store.createAgent("替换试验", dir).agent;
    const identity = join(dir, "identity");
    mkdirSync(identity);
    store.run(
      "UPDATE agents SET agent_directory=? WHERE id=?",
      identity,
      agent.id,
    );
    const add = async (name: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          headers,
          payload: {
            provider: "amazon-bedrock",
            name,
            key: name,
          },
        })
      ).json().id as string;
    const old = await add("old"),
      next = await add("next");
    const assign = (account: string, replace?: boolean) =>
      app.inject({
        method: "POST",
        url: `/api/assign/${agent.ref}`,
        headers,
        payload: { account, ...(replace === undefined ? {} : { replace }) },
      });
    assert.equal((await assign(old)).statusCode, 200);
    assert.deepEqual((await assign(old)).json().alreadyAssigned, true);
    const conflict = await assign(next);
    assert.equal(conflict.statusCode, 409);
    assert.match(
      conflict.json().nextCommand,
      new RegExp(`atrium unassign ${agent.name} amazon-bedrock`),
    );
    store.run("UPDATE agents SET name=? WHERE id=?", "张 三", agent.id);
    const spacedConflict = await assign(next);
    assert.equal(spacedConflict.statusCode, 409);
    assert.equal(
      spacedConflict.json().nextCommand,
      `atrium unassign ${agent.ref} amazon-bedrock`,
    );
    store.run("UPDATE agents SET name=? WHERE id=?", "张;三", agent.id);
    assert.equal(
      (await assign(next)).json().nextCommand,
      `atrium unassign ${agent.ref} amazon-bedrock`,
    );
    store.run("UPDATE agents SET name=? WHERE id=?", agent.name, agent.id);
    assert.equal((await assign("k999999", true)).statusCode, 404);
    assert.equal(
      JSON.parse(readFileSync(join(identity, "auth.json"), "utf8"))[
        "amazon-bedrock"
      ].key,
      "old",
    );
    store.run(
      `CREATE TRIGGER deny_swap BEFORE UPDATE ON account_assignments BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
    );
    assert.equal((await assign(next, true)).statusCode, 500);
    assert.equal(
      JSON.parse(readFileSync(join(identity, "auth.json"), "utf8"))[
        "amazon-bedrock"
      ].key,
      "old",
    );
    store.run("DROP TRIGGER deny_swap");
    assert.equal((await assign(next, true)).statusCode, 200);
    const list = (
      await app.inject({ method: "GET", url: "/api/accounts", headers })
    ).json() as { id: string; assigned: string[] }[];
    assert.deepEqual(list.find((entry) => entry.id === old)?.assigned, []);
    assert.deepEqual(list.find((entry) => entry.id === next)?.assigned, [
      agent.ref,
    ]);
    assert.equal(
      JSON.parse(readFileSync(join(identity, "auth.json"), "utf8"))[
        "amazon-bedrock"
      ].key,
      "next",
    );
  } finally {
    await app.close();
  }
});

test("account HTTP responses omit credentials even on malformed stored JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-account-http-"));
  const { app, store } = await createApp({
    auth: false,
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
      payload: {
        provider: "amazon-bedrock",
        name: "http",
        key,
      },
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
      `{ "amazon-bedrock": "${key}`,
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

test("refresh failure labels distinguish expired login, network, plugin and unknown without echoing secrets", () => {
  const secret = "SECRET_REFRESH_TOKEN";
  const cases = [
    [{ message: `invalid_grant ${secret}` }, "登录已失效，需要重新登录"],
    [
      { message: `fetch failed ECONNRESET ${secret}` },
      "网络或超时，稍后自动重试",
    ],
    [new Error(`extension plugin failed ${secret}`), "Provider 插件加载失败"],
    [{ message: secret }, "未知错误"],
  ] as const;
  for (const [error, expected] of cases) {
    const label = classifyRefreshError(error);
    assert.equal(label, expected);
    assert.equal(label.includes(secret), false);
  }
});

test("startup quarantines one broken account and assigned identity, keeps other accounts usable", async () => {
  const { dir, store, agent, agentDirectory, accounts } = fixture();
  const bad = accounts.add("deepseek", "broken", "BAD_KEY").id;
  store.run(
    "UPDATE accounts SET type='oauth',expires=? WHERE number=?",
    Date.now() - 1000,
    Number(bad.slice(1)),
  );
  const good = accounts.add("openai", "healthy", "GOOD_KEY").id;
  accounts.assign(agent.id, good);
  const badFile = join(accounts.root, bad, "auth.json");
  const identityFile = join(agentDirectory, "auth.json");
  writeFileSync(badFile, "{damaged BAD_KEY", { mode: 0o600 });
  writeFileSync(identityFile, "{damaged IDENTITY_KEY", { mode: 0o600 });
  const restarted = new Accounts(store, dir);
  assert.equal(restarted.list().find((a) => a.id === bad)?.status, "error");
  assert.equal(restarted.list().find((a) => a.id === good)?.status, "error");
  assert.equal(readFileSync(identityFile, "utf8").includes("GOOD_KEY"), true);
  const files = (await import("node:fs")).readdirSync;
  assert.equal(
    files(join(accounts.root, bad)).some((f) =>
      f.startsWith("auth.json.preserved-"),
    ),
    true,
  );
  assert.equal(
    files(agentDirectory).some((f) => f.startsWith("auth.json.preserved-")),
    true,
  );
  await restarted.refresh();
  assert.equal(
    restarted.list().find((a) => a.id === bad)?.last_error,
    "账号凭据损坏，原文件已隔离",
  );
  const extra = restarted.add("deepseek", "available", "ANOTHER_KEY").id;
  assert.equal(restarted.list().find((a) => a.id === extra)?.status, "ready");
  store.close();
});

test("one quarantined OAuth account does not stop other due refreshes", async () => {
  const { dir, store, accounts } = fixture();
  const bad = accounts.add("deepseek", "bad", "BAD_KEY").id;
  const good = accounts.add("openai", "good", "GOOD_KEY").id;
  for (const ref of [bad, good])
    store.run(
      "UPDATE accounts SET type='oauth',expires=? WHERE number=?",
      Date.now() - 1000,
      Number(ref.slice(1)),
    );
  writeFileSync(join(accounts.root, bad, "auth.json"), "{broken SECRET", {
    mode: 0o600,
  });
  const restarted = new Accounts(store, dir);
  const files = new AccountFiles(store, accounts.root);
  const attempts: number[] = [];
  const refresh = new AccountRefresh(store, files, {
    run: async (row) => {
      attempts.push(row.number);
      files.save(row, {
        type: "oauth",
        access: "FRESH_ACCESS",
        refresh: "FRESH_REFRESH",
        expires: Date.now() + 3600_000,
      });
    },
    close: () => {},
  });
  await refresh.refresh();
  assert.deepEqual(attempts, [Number(good.slice(1))]);
  assert.equal(
    restarted.list().find((a) => a.id === bad)?.last_error,
    "账号凭据损坏，原文件已隔离",
  );
  assert.equal(restarted.list().find((a) => a.id === good)?.status, "ready");
  store.close();
});

test("deleted identities lose only their assignments; deleting an account clears every remaining identity file", () => {
  const { dir, store, agent, agentDirectory, accounts } = fixture();
  const peer = store.createAgent("另一身份", dir).agent;
  const peerDirectory = join(dir, "peer");
  mkdirSync(peerDirectory);
  store.run(
    "UPDATE agents SET agent_directory=? WHERE id=?",
    peerDirectory,
    peer.id,
  );
  const third = store.createAgent("第三身份", dir).agent;
  const thirdDirectory = join(dir, "third");
  mkdirSync(thirdDirectory);
  store.run(
    "UPDATE agents SET agent_directory=? WHERE id=?",
    thirdDirectory,
    third.id,
  );
  const account = accounts.add("deepseek", "shared", "COMMON_KEY").id;
  accounts.assign(agent.id, account);
  accounts.assign(peer.id, account);
  accounts.assign(third.id, account);
  store.deleteAgent(agent.id);
  assert.deepEqual(accounts.list()[0]?.assigned, [peer.ref, third.ref]);
  store.run(
    "INSERT INTO credential_modes(agent_id,mode) VALUES(?,'assigned')",
    agent.id,
  );
  new Accounts(store, dir);
  assert.equal(
    store.one("SELECT 1 FROM credential_modes WHERE agent_id=?", agent.id),
    undefined,
  );
  assert.equal(
    readFileSync(join(peerDirectory, "auth.json"), "utf8").includes(
      "COMMON_KEY",
    ),
    true,
  );
  accounts.remove(account);
  for (const directory of [peerDirectory, thirdDirectory])
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, "auth.json"), "utf8")),
      {},
    );
  assert.equal(
    readFileSync(join(agentDirectory, "auth.json"), "utf8").includes(
      "COMMON_KEY",
    ),
    true,
  );
  store.close();
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
