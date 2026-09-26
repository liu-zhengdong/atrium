import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountWorker,
  validationExitReason,
} from "../server/account-worker-client.ts";
import { validateKey, validationReason } from "../server/account-validation.ts";

test("校验进程退出按事实分开报：超时、插件加载失败、报错、无结果文案互不相同", () => {
  const timeout = validationExitReason({
    timedOut: true,
    phase: "加载插件",
    elapsedMs: 15_003,
    code: null,
  });
  assert.equal(timeout, "校验超时：等了 15 秒未完成，卡在「加载插件」");
  assert.equal(
    validationExitReason({
      timedOut: true,
      phase: "请求供应商",
      elapsedMs: 15_000,
      code: null,
    }),
    "校验超时：等了 15 秒未完成，卡在「请求供应商」",
  );
  const pluginFailed = validationExitReason({
    timedOut: false,
    phase: "加载插件",
    elapsedMs: 800,
    errorMessage: "Provider 插件加载失败",
    code: 1,
  });
  assert.equal(pluginFailed, "Provider 插件加载失败");
  const workerError = validationExitReason({
    timedOut: false,
    phase: "请求供应商",
    elapsedMs: 1_200,
    errorMessage: "网络或超时，稍后自动重试",
    code: 1,
  });
  assert.equal(workerError, "校验进程报错：网络或超时，稍后自动重试");
  const noMessage = validationExitReason({
    timedOut: false,
    phase: "加载插件",
    elapsedMs: 500,
    code: 1,
  });
  assert.match(noMessage, /未返回结果/);
  assert.match(noMessage, /退出码 1/);
  // 超时与报错不能是同一句话
  assert.notEqual(timeout, workerError);
  assert.notEqual(timeout, pluginFailed);
});

function fixturePackage(directory: string, marker: string) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: `probe-${marker}`,
      version: "1.0.0",
      pi: { extensions: ["ext.mjs"] },
    }),
  );
  writeFileSync(
    join(directory, "ext.mjs"),
    `import { writeFileSync } from "node:fs";\nexport default function probe() {\n  writeFileSync(${JSON.stringify(marker)}, "loaded");\n}\n`,
  );
}

test("内置与插件校验只带需要的包：不复制模板、插件包仍加载、秒级完成", async () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-key-scope-test-"));
  const markerA = join(root, "marker-template-loaded");
  const markerB = join(root, "marker-plugin-loaded");
  const template = join(root, "template");
  const plugin = join(root, "plugin");
  mkdirSync(template, { recursive: true });
  fixturePackage(join(template, "probe-a"), markerA);
  writeFileSync(
    join(template, "settings.json"),
    JSON.stringify({ packages: [join(template, "probe-a")] }),
  );
  fixturePackage(plugin, markerB);
  const old = process.env.ATRIUM_PI_TEMPLATE;
  process.env.ATRIUM_PI_TEMPLATE = template;
  const worker = new AccountWorker(
    {} as ConstructorParameters<typeof AccountWorker>[0],
  );
  try {
    const startedAt = Date.now();
    const validation = await validateKey(
      worker,
      {
        id: "no-such-provider",
        name: "no-such-provider",
        packagePath: plugin,
        methods: ["api_key"],
      },
      "FAKE_KEY",
    );
    const elapsedMs = Date.now() - startedAt;
    // 此供应商没有模型可请求，整个过程不联网；老路径复制模板会在 15 秒被杀并误报
    assert.equal(
      validation.status,
      "skipped",
      `意外结果：${JSON.stringify(validation)}`,
    );
    assert.ok(
      elapsedMs < 10_000,
      `应在秒级完成（不装模板的包），实际 ${elapsedMs}ms`,
    );
    assert.ok(!existsSync(markerA), "模板里的包不应被复制加载");
    assert.ok(existsSync(markerB), "只带注册它的插件包时插件仍要加载");
  } finally {
    worker.close();
    if (old === undefined) delete process.env.ATRIUM_PI_TEMPLATE;
    else process.env.ATRIUM_PI_TEMPLATE = old;
    rmSync(root, { recursive: true, force: true });
  }
});

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
