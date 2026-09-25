import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import { Runtimes } from "../server/runtime.ts";
import { containerSettings, validMounts } from "../server/container.ts";
import { listenContainerMcp } from "../server/container-mcp.ts";

test("身份默认不容器化，切换时保留旧会话、授权目录必须存在，claude-bridge 被拒", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-container-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.method(Runtimes.prototype, "discover", async () => {});
  const { app, store } = await createApp({
    data: join(root, "data"),
    desktops: join(root, "desktop"),
    piHome: join(root, "pi"),
  });
  t.after(() => app.close());
  const directory = join(root, "agent");
  mkdirSync(directory);
  writeFileSync(
    join(directory, "settings.json"),
    JSON.stringify({ packages: [] }),
  );
  const agent = store.createAgent("隔离者", root).agent;
  store.run(
    "UPDATE agents SET agent_directory=?,session_file=? WHERE id=?",
    directory,
    "/host/old-session",
    agent.id,
  );
  const url = `/api/agents/${agent.id}/container`;
  assert.equal(store.agent(agent.id).container.enabled, false);
  const missing = await app.inject({
    method: "PUT",
    url,
    payload: { enabled: true, mounts: ["/missing-167"] },
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(store.agent(agent.id).session_file, "/host/old-session");
  const enabled = await app.inject({
    method: "PUT",
    url,
    payload: { enabled: true, mounts: [root] },
  });
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal(store.agent(agent.id).container.enabled, true);
  assert.deepEqual(store.agent(agent.id).container.mounts, [
    realpathSync(root),
  ]);
  assert.equal(store.agent(agent.id).session_file, null);
  assert.match(store.agent(agent.id).session_reset_reason ?? "", /新会话/);
  assert.equal(
    (await app.inject({ method: "POST", url: `${url}/pause` })).statusCode,
    409,
  );
  const pumping = new Map([[agent.id, Promise.resolve()]]);
  const turns = new Map<string, unknown>();
  const connections = new Map<string, { info: { busy: boolean } }>();
  const runtime = Object.assign(Object.create(Runtimes.prototype), {
    store,
    owned: () => true,
    pumping,
    turns,
    connections,
  }) as Runtimes;
  await assert.rejects(runtime.pause(agent.id), /正在处理回合/);
  pumping.clear();
  turns.set(agent.id, {});
  await assert.rejects(runtime.pause(agent.id), /正在处理回合/);
  turns.clear();
  connections.set(agent.id, { info: { busy: true } });
  await assert.rejects(runtime.pause(agent.id), /正在处理回合/);
  assert.equal(store.agent(agent.id).container.paused, false);
  writeFileSync(
    join(directory, "settings.json"),
    JSON.stringify({ packages: ["claude-bridge"] }),
  );
  const denied = await app.inject({
    method: "PUT",
    url,
    payload: { enabled: true },
  });
  assert.equal(denied.statusCode, 409);
  assert.match(denied.body, /钥匙串/);
  assert.equal(
    store.agent(agent.id).container.enabled,
    true,
    "已启用身份不会因拒绝丢失状态",
  );
});

test("容器配置映射工作目录与扩展，不修改宿主原文件；不允许相对挂载与根目录", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-container-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "agent"),
    workspace = join(root, "workspace");
  mkdirSync(directory);
  mkdirSync(workspace);
  const settings = {
    packages: ["/test/package"],
    env: {
      working: join(workspace, "src"),
      identity: join(directory, "SYSTEM.md"),
    },
  };
  writeFileSync(join(directory, "settings.json"), JSON.stringify(settings));
  const mapped = containerSettings(directory, workspace, [], root, "a1");
  const target = JSON.parse(readFileSync(mapped, "utf8"));
  assert.equal(target.env.working, "/workspace/src");
  assert.equal(target.env.identity, "/agent/SYSTEM.md");
  assert.deepEqual(
    JSON.parse(readFileSync(join(directory, "settings.json"), "utf8")),
    settings,
  );
  assert.throws(() => validMounts(["./repo"]), /绝对路径/);
  assert.throws(() => validMounts(["/"]), /根目录/);
  assert.throws(
    () => validMounts([join(directory, "settings.json")]),
    /只能授权目录/,
  );
});

test("独立端口只转发 MCP POST，不转发管理路径、其他方法和伪造 Host", async (t) => {
  const upstream = createServer((req, res) =>
    res.end(`${req.method} ${req.url}`),
  );
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  t.after(() => upstream.close());
  const port = (upstream.address() as { port: number }).port;
  const bridge = await listenContainerMcp(port);
  t.after(() => bridge.close());
  const send = (
    path: string,
    method: string,
    host = `host.docker.internal:${port + 1}`,
  ) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: port + 1,
          path,
          method,
          headers: { host },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  const mcp = "/mcp/5a34fad0-899e-4a1c-a661-19ff6a08193b";
  assert.deepEqual(await send(mcp, "POST"), {
    status: 200,
    body: `POST ${mcp}`,
  });
  for (const [path, method, host] of [
    ["/api/agents", "GET"],
    [mcp, "GET"],
    [`${mcp}/../api/agents`, "POST"],
    [mcp, "POST", `localhost:${port + 1}`],
  ]) {
    assert.equal((await send(path!, method!, host)).status, 403);
  }
});
