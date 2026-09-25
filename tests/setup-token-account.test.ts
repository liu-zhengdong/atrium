import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  lstatSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Accounts } from "../server/accounts.ts";
import { createApp } from "../server/app.ts";
import { RunnerDaemon } from "../server/runner-daemon.ts";
import { randomUUID } from "node:crypto";
import { assignedSetupTokenRef } from "../server/launch-account.ts";
import {
  readSetupToken,
  validateSetupToken,
} from "../server/setup-token-account.ts";
import { Store } from "../server/store.ts";

function fixture(t: import("node:test").TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "atrium-setup-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const template = join(dir, "template");
  mkdirSync(template);
  writeFileSync(join(template, "auth.json"), "{}\n", { mode: 0o600 });
  t.mock.property(process, "env", {
    ...process.env,
    ATRIUM_PI_TEMPLATE: template,
  });
  const store = new Store(join(dir, "atrium.sqlite"));
  const agent = store.createAgent("测试身份", dir).agent;
  const identity = join(dir, "identity");
  mkdirSync(identity);
  store.run(
    "UPDATE agents SET agent_directory=? WHERE id=?",
    identity,
    agent.id,
  );
  return { dir, store, agent, identity, accounts: new Accounts(store, dir) };
}

test("setup-token account is stored only in a private file, never auth.json", async (t) => {
  const { store, agent, identity, accounts } = fixture(t);
  const { id } = await accounts.addSetupToken(
    "独立 Claude",
    "FAKE_TOKEN_123",
    () => undefined,
  );
  assert.equal(
    lstatSync(join(accounts.root, id, "claude-setup-token")).mode & 0o777,
    0o600,
  );
  assert.equal(
    readFileSync(join(accounts.root, id, "claude-setup-token"), "utf8"),
    "FAKE_TOKEN_123\n",
  );
  accounts.assign(agent.id, id);
  assert.equal(assignedSetupTokenRef(store, agent.id), id);
  const authFile = join(identity, "auth.json");
  if (existsSync(authFile))
    assert.doesNotMatch(
      readFileSync(authFile, "utf8"),
      /FAKE_TOKEN_123|claude-bridge/,
    );
  assert.equal(accounts.list().find((a) => a.id === id)?.type, "setup_token");
  store.close();
});

test("invalid replacement preserves existing credential; missing or symlinked token affects only its own account", async (t) => {
  const { dir, store, accounts } = fixture(t);
  const good = (
    await accounts.addSetupToken("旧", "OLD_TOKEN_123", () => undefined)
  ).id;
  accounts.add("deepseek", "other", "OTHER_KEY");
  await assert.rejects(
    accounts.replaceSetupToken(good, "BAD_TOKEN", () => {
      throw new Error("invalid");
    }),
    /invalid/,
  );
  assert.equal(
    readSetupToken(accounts.root, Number(good.slice(1))),
    "OLD_TOKEN_123",
  );
  await accounts.replaceSetupToken(good, "NEW_TOKEN_123", () => undefined);
  assert.equal(
    readSetupToken(accounts.root, Number(good.slice(1))),
    "NEW_TOKEN_123",
  );
  const tokenPath = join(accounts.root, good, "claude-setup-token");
  const other = join(accounts.root, "other-token");
  writeFileSync(other, "SYMLINK_TOKEN_123");
  // Atomic replacement of file with symlink; the invalid file remains for investigation.
  unlinkSync(tokenPath);
  symlinkSync(other, tokenPath);
  const restarted = new Accounts(store, dir);
  assert.equal(restarted.list().find((a) => a.id === good)?.status, "error");
  assert.equal(
    restarted.list().find((a) => a.provider === "deepseek")?.status,
    "ready",
  );
  assert.throws(() => readSetupToken(accounts.root, Number(good.slice(1))));
  store.close();
});

test("replacement rechecks whether the account is in use after asynchronous validation", async (t) => {
  const { store, accounts } = fixture(t);
  const { id } = await accounts.addSetupToken(
    "independent",
    "FAKE_ORIGINAL",
    () => undefined,
  );
  let validated = false;
  await assert.rejects(
    accounts.replaceSetupToken(
      id,
      "FAKE_ROTATED",
      async () => {
        validated = true;
      },
      () => {
        assert.equal(validated, true);
        throw new Error("account is now running");
      },
    ),
    /account is now running/,
  );
  assert.equal(
    readSetupToken(accounts.root, Number(id.slice(1))),
    "FAKE_ORIGINAL",
  );
  store.close();
});

test("restart repairs only the v0.1.9 false-corruption marker when the token file is intact", async (t) => {
  const { dir, store, accounts } = fixture(t);
  const old = (
    await accounts.addSetupToken("rollback", "FAKE_TOKEN_123", () => undefined)
  ).id;
  const rejected = (
    await accounts.addSetupToken("expired", "OTHER_TOKEN_123", () => undefined)
  ).id;
  store.run(
    "UPDATE accounts SET status='error',last_error=? WHERE number=?",
    "账号凭据损坏，原文件已隔离",
    Number(old.slice(1)),
  );
  store.run(
    "UPDATE accounts SET status='error',last_error=? WHERE number=?",
    "Claude setup-token 失效；请更换账号令牌",
    Number(rejected.slice(1)),
  );
  const recovered = new Accounts(store, dir).list();
  assert.equal(recovered.find((a) => a.id === old)?.status, "ready");
  assert.equal(recovered.find((a) => a.id === old)?.last_error, null);
  assert.equal(recovered.find((a) => a.id === rejected)?.status, "error");
  assert.equal(
    recovered.find((a) => a.id === rejected)?.last_error,
    "Claude setup-token 失效；请更换账号令牌",
  );
  store.close();
});

test("real previous pi-atrium release cannot start a token identity or call the security stub", async (t) => {
  const oldAdapter = process.env.PI_ATRIUM_PREVIOUS_ENTRY;
  if (!oldAdapter)
    return t.skip(
      "set PI_ATRIUM_PREVIOUS_ENTRY to the previous release's dist/index.js for the release gate",
    );
  const dir = mkdtempSync(join(tmpdir(), "atrium-old-adapter-"));
  const called = join(dir, "security-called");
  writeFileSync(
    join(dir, "security"),
    `#!/bin/sh\nprintf called >> '${called}'\nexit 1\n`,
    { mode: 0o700 },
  );
  const daemon = new RunnerDaemon(
    "ws://127.0.0.1:4310/runner/v1",
    "fake-token",
    {
      ...process.env,
      ATRIUM_DATA: join(dir, "data"),
      PI_ACP_DIR: join(dir, "acp"),
      ATRIUM_PI_ACP_ENTRY: oldAdapter,
      PATH: `${dir}:${process.env.PATH}`,
    },
  );
  t.after(() => {
    daemon.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = randomUUID();
  await assert.rejects(
    daemon["handle"]("acp.request", {
      agentId: id,
      params: {
        method: "_pi/identity/start",
        params: { identityId: id, cwd: dir, launchSecretAccount: "k1" },
      },
    }),
    /pi-atrium#<新版提交>/,
  );
  assert.equal(existsSync(called), false);
});

test("HTTP rejects an invalid token without persisting it; replacement is atomic and never echoes token", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-setup-api-"));
  const template = join(dir, "template");
  mkdirSync(template);
  writeFileSync(
    join(template, "settings.json"),
    JSON.stringify({ packages: [] }),
  );
  const fake = join(dir, "claude");
  writeFileSync(
    fake,
    `#!/usr/bin/env node\nconst ok = process.env.CLAUDE_CODE_OAUTH_TOKEN !== 'FAKE_REJECTED_TOKEN';\nconsole.log(JSON.stringify({is_error: !ok, result: ok ? 'OK' : 'denied'}));\n`,
    { mode: 0o700 },
  );
  t.mock.property(process, "env", {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    ATRIUM_PI_TEMPLATE: template,
  });
  const { app, store } = await createApp({
    auth: false,
    data: join(dir, "data"),
    runtime: false,
  });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const invalid = await app.inject({
    method: "POST",
    url: "/api/accounts/setup-token",
    payload: { name: "bad", token: "FAKE_REJECTED_TOKEN" },
  });
  assert.equal(invalid.statusCode, 400);
  assert.doesNotMatch(invalid.body, /FAKE_REJECTED_TOKEN/);
  assert.deepEqual(new Accounts(store, join(dir, "data")).list(), []);
  const created = await app.inject({
    method: "POST",
    url: "/api/accounts/setup-token",
    payload: { name: "Claude 独立账号", token: "FAKE_VALID_TOKEN" },
  });
  assert.equal(created.statusCode, 200);
  const ref = created.json().id as string;
  assert.match(ref, /^k[0-9]+$/);
  assert.doesNotMatch(created.body, /FAKE_VALID_TOKEN/);
  const replaced = await app.inject({
    method: "PUT",
    url: `/api/accounts/${ref}/setup-token`,
    payload: { token: "FAKE_REJECTED_TOKEN" },
  });
  assert.equal(replaced.statusCode, 400);
  assert.doesNotMatch(replaced.body, /FAKE_REJECTED_TOKEN/);
  assert.equal(
    readSetupToken(join(dir, "data", "accounts"), Number(ref.slice(1))),
    "FAKE_VALID_TOKEN",
  );
});

test("token validation keeps the service event loop responsive", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-validator-async-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, "slow-claude");
  writeFileSync(fake, "#!/bin/sh\nsleep 0.1\nprintf '{\"is_error\":false}'\n", {
    mode: 0o700,
  });
  let served = false;
  setTimeout(() => {
    served = true;
  }, 20);
  await validateSetupToken("FAKE_TOKEN_123", fake);
  assert.equal(served, true);
});

test("validator uses isolated HOME and config with only the supplied token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-validator-test-"));
  const fake = join(dir, "claude-fake");
  const capture = join(dir, "captured.json");
  writeFileSync(
    fake,
    `#!/usr/bin/env node\nconst fs = require('fs');\nfs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({home:process.env.HOME,config:process.env.CLAUDE_CONFIG_DIR,token:process.env.CLAUDE_CODE_OAUTH_TOKEN,apiKey:process.env.ANTHROPIC_API_KEY,authToken:process.env.ANTHROPIC_AUTH_TOKEN,awsKey:process.env.AWS_ACCESS_KEY_ID,args:process.argv.slice(2)}));\nconsole.log(JSON.stringify({is_error:false,result:'OK'}));\n`,
    { mode: 0o700 },
  );
  const before = { ...process.env };
  try {
    process.env.ANTHROPIC_API_KEY = "DO_NOT_INHERIT";
    process.env.ANTHROPIC_AUTH_TOKEN = "DO_NOT_INHERIT";
    process.env.AWS_ACCESS_KEY_ID = "DO_NOT_INHERIT";
    await validateSetupToken("FAKE_TOKEN_123", fake);
    const result = JSON.parse(readFileSync(capture, "utf8")) as {
      home: string;
      config: string;
      token: string;
      apiKey?: string;
      authToken?: string;
      awsKey?: string;
      args: string[];
    };
    assert.equal(result.home, result.config);
    assert.notEqual(result.home, process.env.HOME);
    assert.equal(result.token, "FAKE_TOKEN_123");
    assert.equal(result.apiKey, undefined);
    assert.equal(result.authToken, undefined);
    assert.equal(result.awsKey, undefined);
    assert.ok(result.args.includes("--safe-mode"));
  } finally {
    process.env = before;
  }
});
