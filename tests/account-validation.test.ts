import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountWorker } from "../server/account-worker-client.ts";
import { validateKey, validationReason } from "../server/account-validation.ts";

test("401 JSON 错误只保留 message，不展示 request_id 和元数据", () => {
  assert.equal(
    validationReason(
      '401: {"message":"Authentication Fails, Your api key: ****-123 is invalid (request_id: req_1)","type":"invalid","param":null,"code":"bad"}',
    ),
    "401：Authentication Fails, Your api key: ****-123 is invalid",
  );
  assert.equal(
    validationReason('401: {"message":"FAKE_DENIED_42"}'),
    "401：FAKE_DENIED_42",
  );
});

const config = (port: number) => ({
  baseUrl: `http://127.0.0.1:${port}/v1`,
  models: [{ id: "demo" }],
});
const provider = {
  id: "local-test",
  name: "local-test",
  packagePath: null,
  methods: ["api_key" as const],
};
test("同一校验层发起实际模型请求；成功、拒绝、超时不会保存或泄漏 key", async () => {
  const server = createServer((req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization === "Bearer BAD_KEY") {
      res
        .writeHead(401, { "content-type": "application/json" })
        .end('{"error":{"message":"not authorized"}}');
      return;
    }
    if (req.headers.authorization === "Bearer HANG_KEY") return;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"demo","choices":[{"index":0,"delta":{"role":"assistant","content":"好"},"finish_reason":null}]}\n\ndata: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), "atrium-validation-test-"));
  writeFileSync(join(dir, "settings.json"), "{}");
  const old = process.env.ATRIUM_PI_TEMPLATE;
  process.env.ATRIUM_PI_TEMPLATE = dir;
  try {
    const worker = new AccountWorker(
      {} as ConstructorParameters<typeof AccountWorker>[0],
    );
    assert.equal(
      (await validateKey(worker, provider, "GOOD_KEY", config(port))).status,
      "verified",
    );
    const bad = await validateKey(worker, provider, "BAD_KEY", config(port));
    assert.equal(bad.status, "rejected");
    assert.doesNotMatch(JSON.stringify(bad), /BAD_KEY/);
    assert.equal(
      (await validateKey(worker, provider, "HANG_KEY", config(port))).status,
      "unverified",
    );
    worker.close();
  } finally {
    if (old === undefined) delete process.env.ATRIUM_PI_TEMPLATE;
    else process.env.ATRIUM_PI_TEMPLATE = old;
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
