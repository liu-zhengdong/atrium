import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { Accounts } from "../server/accounts.ts";

const fixture = async () => {
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end('{"data":[{"id":"demo"}]}');
      return;
    }
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization === "Bearer BAD_KEY") {
      res.writeHead(403).end("provider says DENIED_CODE_42");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"demo","choices":[{"index":0,"delta":{"role":"assistant","content":"好"},"finish_reason":null}]}\n\ndata: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "atrium-custom-test-"));
  const template = join(dir, "template");
  mkdirSync(template);
  writeFileSync(join(template, "settings.json"), "{}");
  const old = process.env.ATRIUM_PI_TEMPLATE;
  process.env.ATRIUM_PI_TEMPLATE = template;
  const store = new Store(join(dir, "atrium.sqlite"));
  const agent = store.createAgent("custom-test", dir).agent;
  const identity = join(dir, "identity");
  mkdirSync(identity);
  writeFileSync(
    join(identity, "settings.json"),
    JSON.stringify({ defaultProvider: "local", defaultModel: "demo" }),
  );
  store.run(
    "UPDATE agents SET agent_directory=? WHERE id=?",
    identity,
    agent.id,
  );
  const accounts = new Accounts(store, dir);
  return {
    server,
    dir,
    store,
    agent,
    identity,
    accounts,
    config: {
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      models: [{ id: "demo" }],
    },
    cleanup: () => {
      accounts.close();
      store.close();
      server.closeAllConnections();
      server.close();
      rmSync(dir, { recursive: true, force: true });
      if (old === undefined) delete process.env.ATRIUM_PI_TEMPLATE;
      else process.env.ATRIUM_PI_TEMPLATE = old;
    },
  };
};
test("自定义供应商拒绝时不保存；分配/编辑/撤销/删除仅触碰自己的模型配置", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.accounts.addValidated("local", "local", "BAD_KEY", false, f.config),
      /DENIED_CODE_42/,
    );
    assert.deepEqual(f.accounts.list(), []);
    const modelFile = join(f.identity, "models.json");
    const cursor = {
      baseUrl: "https://cursor.example/v1",
      api: "openai-completions",
      models: [{ id: "original" }],
    };
    const initial = JSON.stringify({ providers: { cursor } });
    writeFileSync(modelFile, initial);
    const original = JSON.stringify(cursor);
    const created = await f.accounts.addValidated(
      "local",
      "local",
      "GOOD_KEY",
      false,
      f.config,
    );
    assert.equal(created.validation.status, "verified");
    assert.ok(created.id);
    const ref = created.id!;
    assert.equal(
      (await f.accounts.customModels(f.config, "GOOD_KEY")).models[0],
      "demo",
    );
    const unchanged = () =>
      assert.equal(
        JSON.stringify(
          JSON.parse(readFileSync(modelFile, "utf8")).providers.cursor,
        ),
        original,
      );
    f.accounts.assign(f.agent.id, ref);
    unchanged();
    assert.equal(
      JSON.parse(readFileSync(modelFile, "utf8")).providers.local.models[0].id,
      "demo",
    );
    f.accounts.markModelAuthFailure(f.agent.id, "403 forbidden");
    f.store.setFailure(f.agent.id, "模型认证失败，请更换 API Key");
    assert.equal(f.accounts.list()[0]?.status, "error");
    assert.equal(
      (await f.accounts.replaceKey(ref, "GOOD_KEY", false, f.config)).updated,
      true,
    );
    unchanged();
    assert.equal(f.accounts.list()[0]?.status, "ready");
    assert.equal(f.store.failure(f.agent.id), null);
    f.accounts.unassign(f.agent.id, "local");
    unchanged();
    assert.equal(readFileSync(modelFile, "utf8"), initial);
    f.accounts.remove(ref);
    unchanged();
    assert.equal(readFileSync(modelFile, "utf8"), initial);
    assert.equal(f.accounts.customConfig("local"), null);
    assert.doesNotMatch(JSON.stringify(f.accounts.list()), /GOOD_KEY|BAD_KEY/);
  } finally {
    f.cleanup();
  }
});
