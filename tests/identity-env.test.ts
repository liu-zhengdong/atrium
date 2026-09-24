import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanIdentityEnvironment,
  identityEnvironmentContext,
  identityScopedVariables,
  templateChoice,
} from "../server/identity-env.ts";

test("identity directory and alias drop caller session without mutating its environment", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-identity-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const piHome = join(root, "pi");
  const identity = join(piHome, "atrium", "agents", "id1");
  const alias = join(piHome, "agents", "Ada");
  mkdirSync(identity, { recursive: true });
  mkdirSync(join(piHome, "agents"));
  symlinkSync(identity, alias);
  for (const path of [identity, alias]) {
    const source: NodeJS.ProcessEnv = {
      PI_CODING_AGENT_DIR: path,
      PI_CODING_AGENT_SESSION_DIR: join(identity, "sessions"),
      PI_CODING_AGENT: "true",
      PI_SESSION_FILE: "wrong.jsonl",
      PI_SESSION_ID: "wrong",
      PI_PROVIDER: "wrong",
      PI_MODEL: "wrong",
      PI_REASONING_LEVEL: "wrong",
      PI_MCP_TOOL_EXPOSURE: "wrong",
      ATRIUM_DATA: join(root, "data"),
      PI_ACP_PI_COMMAND: "user-pi",
      PI_SKIP_VERSION_CHECK: "1",
    };
    const { env, ignored } = cleanIdentityEnvironment(
      source,
      identityEnvironmentContext(source, piHome),
    );
    assert.deepEqual(ignored, [...identityScopedVariables]);
    for (const key of ignored) assert.equal(env[key], undefined);
    assert.equal(env.ATRIUM_DATA, source.ATRIUM_DATA);
    assert.equal(env.PI_ACP_PI_COMMAND, "user-pi");
    assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
    assert.equal(source.PI_CODING_AGENT_DIR, path);
  }
});

test("user directory, unset, explicit template and recorded external identity", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-identity-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const custom = join(root, "custom");
  const moved = join(root, "moved");
  mkdirSync(custom);
  mkdirSync(moved);
  const piHome = join(root, "pi");
  const source = { PI_CODING_AGENT_DIR: custom, PI_MODEL: "mine" };
  assert.deepEqual(
    cleanIdentityEnvironment(
      source,
      identityEnvironmentContext(source, piHome),
    ),
    {
      env: source,
      ignored: [],
    },
  );
  assert.deepEqual(templateChoice(source), {
    path: custom,
    source: "PI_CODING_AGENT_DIR",
  });
  assert.equal(
    cleanIdentityEnvironment({}, identityEnvironmentContext({}, piHome)).ignored
      .length,
    0,
  );
  assert.equal(templateChoice({}).source, "默认");
  const explicit = { ...source, ATRIUM_PI_TEMPLATE: moved };
  assert.deepEqual(templateChoice(explicit), {
    path: moved,
    source: "ATRIUM_PI_TEMPLATE",
  });
  assert.equal(
    cleanIdentityEnvironment(
      explicit,
      identityEnvironmentContext(explicit, piHome),
    ).ignored.length,
    0,
  );
  assert.deepEqual(
    cleanIdentityEnvironment(
      { PI_CODING_AGENT_DIR: moved },
      identityEnvironmentContext({ PI_CODING_AGENT_DIR: moved }, piHome, [
        moved,
      ]),
    ).ignored,
    ["PI_CODING_AGENT_DIR"],
  );
});
