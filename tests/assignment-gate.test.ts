import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import { Accounts } from "../server/accounts.ts";
import { Runtimes } from "../server/runtime.ts";
import { LOCAL_USER } from "../shared/user.ts";

test("升级移除个人 Pi 链接；未分配启动受阻、通知只记一次；分配后可启动、取消后再被拒", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-assignment-gate-"));
  const data = join(root, "data"),
    template = join(root, "template");
  mkdirSync(template);
  writeFileSync(
    join(template, "settings.json"),
    JSON.stringify({ packages: [] }),
  );
  writeFileSync(join(template, "auth.json"), "PERSONAL_TOKEN");
  t.mock.property(process, "env", {
    ...process.env,
    ATRIUM_PI_TEMPLATE: template,
    PI_ACP_DIR: join(root, "acp"),
  });
  t.mock.method(
    Runtimes.prototype as unknown as {
      rpc: (method: string) => Promise<unknown>;
    },
    "rpc",
    async (method: string) => {
      if (method === "_pi/identity/start")
        return { runtimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
      return { runtimes: [] };
    },
  );
  t.mock.method(
    Runtimes.prototype as unknown as { bind: () => Promise<void> },
    "bind",
    async () => {},
  );
  const first = await createApp({
    data,
    piHome: join(root, ".pi"),
    desktops: join(root, "desktops"),
  });
  const agent = first.store.createAgent("Atlas", root).agent;
  const directory = join(root, "profile");
  first.store.run(
    "UPDATE agents SET agent_directory=? WHERE id=?",
    directory,
    agent.id,
  );
  mkdirSync(directory);
  writeFileSync(
    join(directory, "settings.json"),
    JSON.stringify({ packages: [] }),
  );
  symlinkSync(join(template, "auth.json"), join(directory, "auth.json"));
  await first.app.close();
  // A changed template path must not leave an old personal-auth link in place.
  const replacement = join(root, "new-template");
  mkdirSync(replacement);
  writeFileSync(join(replacement, "settings.json"), '{"packages":[]}');
  process.env.ATRIUM_PI_TEMPLATE = replacement;
  const { app, store, runtimes } = await createApp({
    data,
    piHome: join(root, ".pi"),
    desktops: join(root, "desktops"),
  });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(existsSync(join(directory, "auth.json")), false);
  assert.equal(
    readFileSync(join(template, "auth.json"), "utf8"),
    "PERSONAL_TOKEN",
  );
  const check = await app.inject({ url: "/api/assignment-check" });
  assert.deepEqual(
    check.json().unassigned.map((a: { command: string }) => a.command),
    ["atrium assign a1 <账号短号>"],
  );
  const start = () =>
    app.inject({ method: "POST", url: `/api/agents/${agent.id}/start` });
  const denied = await start();
  assert.equal(denied.statusCode, 409);
  assert.equal(denied.json().code, "unassigned_account");
  const chat = store.createChat("Atlas", [agent.id], agent.id);
  store.send(LOCAL_USER, { chat_id: chat.id, body: "早上好", mentions: [] });
  await runtimes!.pump(agent.id);
  assert.equal(store.failure(agent.id)?.text, "未分配账号");
  const at = store.failure(agent.id)?.at;
  await runtimes!.pump(agent.id, true);
  assert.equal(store.failure(agent.id)?.at, at);
  const accounts = new Accounts(store, data);
  const account = accounts.add("deepseek", "test", "TEST_KEY").id;
  accounts.assign(agent.id, account);
  assert.equal(store.failure(agent.id), null);
  assert.equal((await start()).statusCode, 200);
  assert.equal(lstatSync(join(directory, "auth.json")).isSymbolicLink(), false);
  accounts.unassign(agent.id, "deepseek");
  assert.equal((await start()).json().code, "unassigned_account");
});
