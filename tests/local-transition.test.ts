import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/legacy-app.ts";
import { Store } from "../server/store.ts";
import { Accounts } from "../server/accounts.ts";
import { assignmentCommand, hasAssignment } from "../server/assignment.ts";

test("一次性过渡仅分配共享 Claude bridge；保留其他身份及人工撤销", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-transition-"));
  const data = join(root, "data"),
    template = join(root, "template");
  mkdirSync(data);
  mkdirSync(template);
  const cli = join(root, "claude");
  writeFileSync(cli, "#!/bin/sh\nexit 2\n");
  chmodSync(cli, 0o700); // Unavailable CLI must not cancel migration.
  writeFileSync(
    join(template, "claude-bridge.json"),
    JSON.stringify({ provider: { pathToClaudeCodeExecutable: cli } }),
  );
  t.mock.property(process, "env", {
    ...process.env,
    ATRIUM_PI_TEMPLATE: template,
  });
  const store = new Store(join(data, "atrium.sqlite"));
  const make = (name: string, provider: string) => {
    const agent = store.createAgent(name, root).agent;
    const directory = join(root, `identity-${name}`);
    mkdirSync(directory, { recursive: true });
    store.run(
      "UPDATE agents SET agent_directory=? WHERE id=?",
      directory,
      agent.id,
    );
    writeFileSync(
      join(directory, "settings.json"),
      JSON.stringify({
        defaultProvider: provider,
        defaultModel: "example",
        packages: ["git:github.com/liu-zhengdong/pi-claude-bridge"],
      }),
    );
    symlinkSync(join(template, "auth.json"), join(directory, "auth.json"));
    return { ...agent, directory };
  };
  const local = make("Claude", "claude-bridge");
  const other = make("Deepseek", "deepseek");
  const assigned = make("Assigned", "deepseek");
  store.run(
    "INSERT INTO accounts(number,provider,name,type) VALUES(5,'deepseek','旧账号','api_key')",
  );
  store.run(
    "INSERT INTO account_assignments(agent_id,provider,account_number) VALUES(?,'deepseek',5)",
    assigned.id,
  );
  store.close();
  const boot = async () => createApp({ auth: false, data, runtime: false });
  const first = await boot();
  assert.equal(hasAssignment(first.store, local.id), true);
  assert.equal(hasAssignment(first.store, other.id), false);
  assert.equal(hasAssignment(first.store, assigned.id), true);
  assert.equal(
    first.store.one<{ status: string }>(
      "SELECT status FROM accounts WHERE type='local'",
    )?.status,
    "error",
  );
  assert.equal(assignmentCommand(first.store, other.id, []), null);
  assert.equal(existsSync(join(local.directory, "auth.json")), false);
  assert.equal(existsSync(join(other.directory, "auth.json")), false);
  assert.equal(
    first.store.one<{ count: number }>(
      "SELECT count(*) AS count FROM accounts WHERE type='local'",
    )?.count,
    1,
  );
  const ref = new Accounts(first.store, data)
    .list()
    .find((a) => a.type === "local")!.id;
  new Accounts(first.store, data).unassign(local.id, "claude-bridge");
  await first.app.close();
  const second = await boot();
  assert.equal(hasAssignment(second.store, local.id), false);
  assert.equal(
    second.store.one<{ count: number }>(
      "SELECT count(*) AS count FROM accounts WHERE type='local'",
    )?.count,
    1,
  );
  assert.equal(
    assignmentCommand(second.store, local.id, [
      { id: ref, provider: "claude-bridge", status: "error" },
    ]),
    `atrium assign ${local.ref} ${ref}`,
  );
  // 已停用供应商的账号不能再分配（#242），撤销后不回指它。
  assert.equal(
    assignmentCommand(
      second.store,
      other.id,
      [{ id: "k9", provider: "antigravity", status: "ready" }],
      "k9",
    ),
    null,
  );
  await second.app.close();
  rmSync(root, { recursive: true, force: true });
});
