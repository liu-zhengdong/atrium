import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../server/accounts.ts";
import { markOwn } from "../server/identity-packages.ts";
import { isAuthOrCapabilityFailure } from "../server/runtime-error.ts";
import { Runtimes } from "../server/runtime.ts";
import { Store } from "../server/store.ts";

test("authentication and capability refusal never restore via a fresh session", async (t) => {
  for (const reason of [
    "Not logged in · Please run /login",
    "独立令牌就绪检查未获肯定回应",
  ]) {
    await t.test(reason, async (child) => {
      const dir = mkdtempSync(join(tmpdir(), "atrium-auth-no-fallback-"));
      const data = join(dir, "data");
      const template = join(dir, "template");
      const identity = join(dir, "identity");
      mkdirSync(data);
      mkdirSync(template);
      mkdirSync(identity);
      writeFileSync(join(template, "settings.json"), '{"packages":[]}');
      writeFileSync(join(identity, "settings.json"), '{"packages":[]}');
      markOwn(identity);
      const session = join(dir, "old-session.jsonl");
      writeFileSync(session, "do not rotate\n");
      child.mock.property(process, "env", {
        ...process.env,
        ATRIUM_DATA: data,
        ATRIUM_PI_TEMPLATE: template,
      });
      const store = new Store(join(data, "atrium.db"));
      const agent = store.createAgent("认证失败", dir).agent;
      store.run(
        "UPDATE agents SET agent_directory=?,session_file=? WHERE id=?",
        identity,
        session,
        agent.id,
      );
      const accounts = new Accounts(store, data);
      const account = await accounts.addSetupToken(
        "fake",
        "FAKE_TOKEN_123",
        () => undefined,
      );
      accounts.assign(agent.id, account.id);
      child.mock.method(Runtimes.prototype, "discover", async () => {});
      const runtimes = new Runtimes(
        store,
        data,
        () => {},
        () => "http://127.0.0.1:4381",
        undefined,
        dir,
      );
      child.after(async () => {
        await runtimes.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      });
      child.mock.method(
        runtimes as unknown as {
          open: () => Promise<{ launchSecretCapable: boolean }>;
        },
        "open",
        async () => ({ launchSecretCapable: true }),
      );
      let rpcCalls = 0;
      child.mock.method(
        runtimes as unknown as { rpc: () => Promise<never> },
        "rpc",
        async () => {
          rpcCalls++;
          throw new Error(reason);
        },
      );
      await assert.rejects(
        runtimes.start(agent.id),
        (error: unknown) =>
          error instanceof Error &&
          (reason.startsWith("独立")
            ? /claude-bridge/.test(error.message)
            : /Not logged in/.test(error.message)),
      );
      assert.equal(rpcCalls, 1, "must not call the new-session fallback RPC");
      assert.equal(store.agent(agent.id).session_file, session);
      assert.equal(readFileSync(session, "utf8"), "do not rotate\n");
    });
  }
  assert.equal(isAuthOrCapabilityFailure(new Error("provider crashed")), false);
});
