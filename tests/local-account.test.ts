import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { Accounts } from "../server/accounts.ts";
import { requireAssignment } from "../server/assignment.ts";
import { Store } from "../server/store.ts";

test("本机 Claude CLI 登录只登记引用：不能导入密钥，分配与复查可拦截故障", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-local-login-"));
  const template = join(root, "template"),
    data = join(root, "data");
  mkdirSync(template);
  const cli = join(root, "claude");
  writeFileSync(
    cli,
    '#!/bin/sh\n[ "$1" = "--version" ] || exit 2\n[ "${ATR_TEST_LOGIN:-true}" = "true" ] || exit 2\necho "1.0"\n',
  );
  chmodSync(cli, 0o700);
  writeFileSync(
    join(template, "claude-bridge.json"),
    JSON.stringify({ provider: { pathToClaudeCodeExecutable: cli } }),
  );
  writeFileSync(
    join(template, "settings.json"),
    JSON.stringify({ packages: [] }),
  );
  t.mock.property(process, "env", {
    ...process.env,
    ATRIUM_PI_TEMPLATE: template,
    ATR_TEST_LOGIN: "true",
  });
  const { app, store } = await createApp({ auth: false, data, runtime: false });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const agent = store.createAgent("乙", root).agent;
  const directory = join(root, "identity");
  mkdirSync(directory);
  store.run(
    "UPDATE agents SET agent_directory=? WHERE id=?",
    directory,
    agent.id,
  );
  writeFileSync(
    join(directory, "settings.json"),
    JSON.stringify({
      packages: ["git:github.com/liu-zhengdong/pi-claude-bridge"],
    }),
  );
  writeFileSync(
    join(directory, "claude-bridge.json"),
    JSON.stringify({ provider: { pathToClaudeCodeExecutable: cli } }),
  );
  const invalid = await app.inject({
    method: "POST",
    url: "/api/accounts/local",
    payload: { provider: "deepseek" },
  });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(new Accounts(store, data).list(), []);
  const added = await app.inject({
    method: "POST",
    url: "/api/accounts/local",
    payload: { provider: "claude-bridge" },
  });
  assert.equal(added.statusCode, 200);
  const ref = added.json().id as string;
  assert.match(ref, /^k\d+$/);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/accounts/local",
        payload: { provider: "claude-bridge" },
      })
    ).statusCode,
    409,
  );
  const accounts = new Accounts(store, data);
  assert.deepEqual(
    accounts.list().map(({ type, status }) => ({ type, status })),
    [{ type: "local", status: "ready" }],
  );
  accounts.assign(agent.id, ref);
  requireAssignment(store, agent.id);
  assert.equal(existsSync(join(directory, "auth.json")), false);
  assert.equal(existsSync(join(data, "accounts", ref, "auth.json")), false);
  assert.doesNotMatch(JSON.stringify(accounts.list()), /private@example/);
  process.env.ATR_TEST_LOGIN = "false";
  assert.throws(
    () => requireAssignment(store, agent.id),
    (error: { code?: string; nextCommand?: string }) => {
      assert.equal(error.code, "local_login_unavailable");
      assert.equal(error.nextCommand, "claude --version");
      return true;
    },
  );
  const checked = await app.inject({
    method: "POST",
    url: `/api/accounts/${ref}/check`,
    payload: {},
  });
  assert.equal(checked.json().status, "error");
  assert.doesNotMatch(checked.body, /private@example/);
  assert.equal(accounts.checkLocal(ref).status, "error");
  process.env.ATR_TEST_LOGIN = "true";
  assert.equal(accounts.checkLocal(ref).status, "ready");
  requireAssignment(store, agent.id);
  accounts.unassign(agent.id, "claude-bridge");
  assert.throws(() => requireAssignment(store, agent.id), /未分配账号/);
  assert.equal(existsSync(join(directory, "auth.json")), false);
  accounts.remove(ref);
  assert.deepEqual(accounts.list(), []);
});

test("旧库迁移保留账号、分配及已用短号，重复打开幂等", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-local-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "atrium.sqlite");
  const first = new Store(file);
  const agent = first.createAgent("Atlas", root).agent;
  first.run(
    "INSERT INTO accounts(number,provider,name,type,status) VALUES(4,'deepseek','old','api_key','ready')",
  );
  first.run(
    "INSERT INTO account_assignments(agent_id,provider,account_number) VALUES(?, 'deepseek',4)",
    agent.id,
  );
  first.run(
    "INSERT INTO accounts(number,provider,name,type,status) VALUES(19,'temp','removed','api_key','ready')",
  );
  first.run("DELETE FROM accounts WHERE number=19");
  first.close();
  const legacy = new DatabaseSync(file);
  legacy.exec(
    "PRAGMA foreign_keys=OFF; CREATE TABLE accounts_old (number INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('oauth','api_key')), expires INTEGER, status TEXT NOT NULL DEFAULT 'ready', last_error TEXT); INSERT INTO accounts_old(number,provider,name,type,expires,status,last_error) SELECT number,provider,name,type,expires,status,last_error FROM accounts; DROP TABLE accounts; ALTER TABLE accounts_old RENAME TO accounts; UPDATE sqlite_sequence SET seq=19 WHERE name='accounts'; PRAGMA foreign_keys=ON;",
  );
  legacy.close();
  const upgraded = new Store(file);
  assert.equal(
    upgraded.one<{ count: number }>(
      "SELECT count(*) AS count FROM pragma_foreign_key_check",
    )?.count,
    0,
  );
  assert.equal(
    upgraded.one<{ number: number }>(
      "SELECT account_number AS number FROM account_assignments WHERE agent_id=?",
      agent.id,
    )?.number,
    4,
  );
  assert.equal(
    upgraded.one<{ number: number }>(
      "SELECT number FROM accounts WHERE number=4",
    )?.number,
    4,
  );
  const next = upgraded.run(
    "INSERT INTO accounts(provider,name,type,status) VALUES('claude-bridge','Claude CLI','local','ready')",
  );
  assert.equal(Number(next.lastInsertRowid), 20);
  upgraded.close();
  const reopened = new Store(file);
  assert.equal(
    reopened.one<{ number: number }>(
      "SELECT number FROM accounts WHERE type='local'",
    )?.number,
    20,
  );
  reopened.close();
});
