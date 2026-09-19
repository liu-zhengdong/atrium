// Real Pi TUI + deterministic local model. This is not a model-quality test.
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createApp } from "../server/app.ts";
import { verifyIdentity } from "./probe-identity.mjs";

const folder = mkdtempSync(join(tmpdir(), "atrium-proof-"));
const profile = join(folder, "profile"),
  cwd = join(folder, "workspace"),
  raw = join(folder, "raw");
for (const dir of [profile, cwd, raw]) mkdirSync(dir, { mode: 0o700 });
process.env.PI_MCP_CONFIG_MODE = "exclusive";
process.env.PI_MCP_TOOL_EXPOSURE = "proxy-only";
process.env.PI_CODING_AGENT_DIR = profile;
process.env.ATRIUM_PI_TEMPLATE = profile;
process.env.PI_ACP_DIR = join(folder, "pi-acp");
process.env.PI_OFFLINE = "1";
const require = createRequire(import.meta.url);
const piAcpEntry = resolve(
  process.env.ATRIUM_PI_ACP_ENTRY ||
    require.resolve("@liuser/pi-acp/dist/index.js"),
);
const piAcpExtension = join(dirname(piAcpEntry), "pi-extension.js");
assert(existsSync(piAcpExtension), "需要构建后的新版 pi-acp 通用扩展");
const ready = join(folder, "ready");
const readyExtension = join(folder, "ready.ts");
writeFileSync(
  readyExtension,
  `import { writeFileSync } from 'node:fs'; export default function(pi) { pi.on('session_start', () => { writeFileSync(${JSON.stringify(ready)}, 'ready'); }); }`,
);
const requests = [],
  hashes = [],
  session = `atrium-${Date.now()}`;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const sourceHashes = {};
for (const path of [
  piAcpEntry,
  piAcpExtension,
  join(dirname(piAcpEntry), "identity.js"),
  "server/app.ts",
  "server/runtime.ts",
  "server/store.ts",
  "server/trace.ts",
  "shared/trace.ts",
  "server/agents.ts",
  "shared/schema.ts",
  "shared/agent-name.ts",
  "server/mcp.ts",
  "scripts/probe-pi.mjs",
  "scripts/probe-identity.mjs",
  "server/profile.ts",
  "bin/atrium.mjs",
]) {
  const content = readFileSync(path);
  sourceHashes[path] = hash(content);
  const name = path.startsWith("/") ? `pi-acp/${basename(path)}` : path;
  const target = join(folder, "source", name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { mode: 0o400 });
  hashes.push({ name: `../source/${name}`, sha256: hash(content) });
}
const wait = async (predicate, label, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等待超时：${label}`);
};
const shell = (value) => `'${value.replaceAll("'", "'\\''")}'`;
let chatId, modelError;
const model = createServer(async (req, res) => {
  try {
    let input = "";
    for await (const chunk of req) input += chunk;
    const body = JSON.parse(input),
      index = requests.length;
    requests.push(body);
    const name = `${String(index + 1).padStart(3, "0")}.json`;
    writeFileSync(join(raw, name), input, { mode: 0o400 });
    hashes.push({ name, sha256: hash(input) });
    assert(requests.length <= 14, "超出模型夹具请求预算");
    const messages = body.messages,
      latestUser = [...messages].reverse().find((m) => m.role === "user");
    const all = JSON.stringify(messages),
      relevant = JSON.stringify(latestUser?.content);
    let calls,
      content = "BASELINE_READY";
    const finishedReply = messages.some(
      (m) =>
        m.role === "tool" &&
        JSON.stringify(m.content).includes("原地接入验证成功"),
    );
    if (all.includes("ATR_INSERT") && !finishedReply) {
      calls = [
        {
          index: 0,
          id: `tool_${index}`,
          type: "function",
          function: {
            name: "mcp",
            arguments: JSON.stringify({
              server: "atrium",
              tool: "send_message",
              args: {
                chat_id: chatId ? store.chatRef(chatId) : store.chats()[0]?.ref,
                body: "原地接入验证成功",
                client_id: randomUUID(),
              },
            }),
          },
        },
      ];
    } else if (all.includes("ATR_INSERT")) content = "已用 Chat 工具回复。";
    else if (
      all.includes("ATR_BUSY") &&
      !messages.some(
        (m) =>
          m.role === "tool" && JSON.stringify(m.content).includes("BUSY_DONE"),
      )
    ) {
      calls = [
        {
          index: 0,
          id: `busy_${index}`,
          type: "function",
          function: {
            name: "bash",
            arguments: JSON.stringify({
              command: `printf started > ${shell(join(cwd, "started"))}; sleep 3; echo BUSY_DONE`,
            }),
          },
        },
      ];
    } else if (relevant?.includes("ATR_BUSY")) content = "BUSY_DONE";
    const base = {
      id: `fixture_${index}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "scripted",
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: calls ? { role: "assistant", tool_calls: calls } : { role: "assistant", content }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  } catch (error) {
    modelError = error;
    res
      .writeHead(500)
      .end(JSON.stringify({ error: { message: String(error) } }));
  }
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
const adapter = resolve(
  process.env.ATRIUM_TEST_ADAPTER ||
    "node_modules/@liuser/pi-mcp-adapter/index.ts",
);
process.env.PI_ACP_MCP_EXTENSION = adapter;
writeFileSync(
  join(profile, "SYSTEM.md"),
  "CUSTOM_SYSTEM_FIXTURE：这是自定义基础身份；外部服务接入不应替换我。\n",
);
writeFileSync(
  join(profile, "settings.json"),
  JSON.stringify({
    defaultProvider: "atrium-fixture",
    defaultModel: "scripted",
    defaultThinkingLevel: "off",
    extensions: [adapter],
  }),
);
writeFileSync(
  join(profile, "mcp.json"),
  JSON.stringify({ mcpServers: {}, settings: { toolExposure: "proxy-only" } }),
);
writeFileSync(
  join(profile, "models.json"),
  JSON.stringify({
    providers: {
      "atrium-fixture": {
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        api: "openai-completions",
        apiKey: "local-fixture-only",
        models: [
          {
            id: "scripted",
            name: "本地验收夹具",
            reasoning: false,
            input: ["text"],
            contextWindow: 32768,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  }),
);
const { app, store, runtimes } = await createApp({
  data: join(folder, "data"),
  desktops: join(folder, "desktops"),
  piHome: join(folder, ".pi"),
  webRoot: process.argv.includes("--ui") ? resolve("dist") : undefined,
});
await app.listen({ port: 0, host: "127.0.0.1" });
const port = app.server.address().port;
let started = false;
try {
  const command = `env PI_CODING_AGENT_DIR=${shell(profile)} PI_ACP_DIR=${shell(process.env.PI_ACP_DIR)} PI_MCP_TOOL_EXPOSURE=proxy-only PI_MCP_CONFIG_MODE=exclusive PI_OFFLINE=1 pi --extension ${shell(piAcpExtension)} --extension ${shell(readyExtension)}`;
  execFileSync("tmux", [
    "new-session",
    "-d",
    "-s",
    session,
    "-x",
    "140",
    "-y",
    "42",
    "-c",
    cwd,
    command,
  ]);
  started = true;
  execFileSync("tmux", [
    "set-window-option",
    "-t",
    session,
    "remain-on-exit",
    "on",
  ]);
  const input = (text) => {
    execFileSync("tmux", ["send-keys", "-t", session, "-l", text]);
    execFileSync("tmux", ["send-keys", "-t", session, "Enter"]);
  };
  const pane = () =>
    execFileSync("tmux", ["capture-pane", "-p", "-t", session, "-S", "-1000"], {
      encoding: "utf8",
    });
  await wait(
    () => existsSync(ready) && pane().includes("scripted"),
    "Pi TUI 就绪",
  );
  input("ATR_BASELINE");
  await wait(
    () => requests.length >= 1 && pane().includes("BASELINE_READY"),
    "接入前真实模型请求",
  );
  await runtimes.discover();
  const initial = await (
    await fetch(`http://127.0.0.1:${port}/api/overview`)
  ).json();
  assert.equal(initial.agents.length, 0, "发现不应预先创建档案");
  assert.equal(initial.discovery.runtimes.length, 1);
  assert.equal(initial.discovery.runtimes[0].bound_agent, null);
  assert.equal(runtimes.connections.size, 0, "浏览名册不接管原 Pi");
  assert.equal(requests.length, 1, "发现不触发模型回合");
  if (process.argv.includes("--ui")) {
    console.log(
      JSON.stringify({
        ui: `http://127.0.0.1:${port}`,
        evidence: folder,
        runtime: initial.discovery.runtimes[0].runtimeId,
      }),
    );
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 300000);
      for (const signal of ["SIGINT", "SIGTERM"])
        process.once(signal, () => {
          clearTimeout(timer);
          resolve();
        });
    });
  } else {
    const available = await (
      await fetch(`http://127.0.0.1:${port}/api/runtimes`)
    ).json();
    assert.equal(available.runtimes.length, 1);
    assert(!JSON.stringify(available).includes("token"));
    const rejected = await fetch(
      `http://127.0.0.1:${port}/api/runtimes/${available.runtimes[0].runtimeId}/chat`,
      { method: "POST" },
    );
    assert.equal(rejected.status, 409, "临时 Pi 不隐式建号");
    const legacy = store.createAgent("旧实例原地接入", cwd);
    writeFileSync(
      join(folder, "data", "credentials", `${legacy.agent.id}.json`),
      JSON.stringify({ token: legacy.token }),
      { mode: 0o600 },
    );
    store.run(
      "UPDATE agents SET runtime_id=?,runtime_pid=? WHERE id=?",
      available.runtimes[0].runtimeId,
      available.runtimes[0].pid,
      legacy.agent.id,
    );
    input("ATR_BUSY");
    await wait(
      () => existsSync(join(cwd, "started")),
      "原任务的真实 bash 工具正在执行",
    );
    const conversation = await fetch(
      `http://127.0.0.1:${port}/api/runtimes/${available.runtimes[0].runtimeId}/chat`,
      { method: "POST" },
    );
    assert.equal(conversation.status, 200, await conversation.clone().text());
    const chat = await conversation.json();
    chatId = chat.id;
    assert.match(chat.ref, /^c[1-9][0-9]*$/, "聊天提供固定短号");
    const agent = store.agent(chat.direct_agent);
    await wait(
      () => runtimes.connections.has(agent.id),
      "点击后自动建立原 Pi 连接",
    );
    const repeated = await fetch(
      `http://127.0.0.1:${port}/api/runtimes/${available.runtimes[0].runtimeId}/chat`,
      { method: "POST" },
    );
    assert.equal((await repeated.json()).id, chatId, "重复点击复用身份与私聊");
    assert.equal(store.agents().length, 1);
    const before = structuredClone(runtimes.connections.get(agent.id).info);
    assert.equal(before.mode, "tui");
    assert.equal(before.busy, true, "MCP 在原任务仍忙时接入");
    assert(readFileSync(before.sessionFile, "utf8").includes("ATR_BASELINE"));
    const collision = store.createAgent("冲突 Agent", cwd).agent;
    await assert.rejects(
      runtimes.attach(collision.id, before.runtimeId),
      /另一个 Agent/,
    );
    assert(runtimes.connections.has(agent.id), "拒绝冲突接入不能断开原 Agent");
    store.send("user", {
      chat_id: chatId,
      body: `@${agent.name} ATR_INSERT：请通过 Chat 工具回复`,
      mentions: [agent.id],
    });
    await runtimes.pump(agent.id);
    await wait(
      () =>
        store
          .timeline(chatId)
          .items.some(
            (m) => m.sender === agent.id && m.body === "原地接入验证成功",
          ),
      "忙时插入后真实 MCP 发回 Chat",
    );
    const after = runtimes.connections.get(agent.id).info;
    assert.equal(before.pid, after.pid);
    assert.equal(before.sessionId, after.sessionId);
    assert.equal(before.sessionFile, after.sessionFile);
    const schemaHash = hash(JSON.stringify(requests[0].tools));
    const systemHash = hash(
      JSON.stringify(
        requests[0].messages.filter(
          (m) => m.role === "system" || m.role === "developer",
        ),
      ),
    );
    for (const request of requests) {
      assert.equal(
        hash(JSON.stringify(request.tools)),
        schemaHash,
        "模型 tools 发生变化",
      );
      assert.equal(
        hash(
          JSON.stringify(
            request.messages.filter(
              (m) => m.role === "system" || m.role === "developer",
            ),
          ),
        ),
        systemHash,
        "system/developer 前缀发生变化",
      );
    }
    assert(
      JSON.stringify(requests[0].messages).includes("CUSTOM_SYSTEM_FIXTURE"),
    );
    const attachedRequests = requests.slice(1);
    assert(
      attachedRequests.some((r) =>
        JSON.stringify(r.messages).includes("Atrium 是你的聊天与事件入口"),
      ),
      "忙时使用说明必须进入实际模型请求，而非仅显示在 TUI",
    );
    assert(
      !JSON.stringify(requests).includes(
        JSON.parse(
          readFileSync(
            join(folder, "data", "credentials", `${agent.id}.json`),
            "utf8",
          ),
        ).token,
      ),
      "连接密钥泄漏到模型上下文",
    );
    assert(!modelError, String(modelError));
    const created = await fetch(`http://127.0.0.1:${port}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "一键新建验证", start: true }),
    });
    assert.equal(created.status, 201);
    const createdAgent = await created.json();
    assert(!createdAgent.start_error, createdAgent.start_error);
    assert.equal(
      runtimes.connections.get(createdAgent.agent.id).info.mode,
      "rpc",
    );
    const rpcResponse = await fetch(`http://127.0.0.1:${port}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "后台验证 Agent" }),
    });
    assert.equal(rpcResponse.status, 201);
    const rpcAgent = (await rpcResponse.json()).agent;
    const originalProfile = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = profile;
      store.configure(rpcAgent.id, { auto_start: true });
      const wakeChat = store.createChat("自动唤醒验证", [rpcAgent.id]);
      store.send("user", {
        chat_id: wakeChat.id,
        body: "自动启动验证",
        mentions: [rpcAgent.id],
      });
      await runtimes.pump(rpcAgent.id);
    } finally {
      if (originalProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalProfile;
    }
    await wait(
      () => runtimes.connections.has(rpcAgent.id),
      "后台 Pi 启动并连接",
    );
    assert.equal(runtimes.connections.get(rpcAgent.id).info.mode, "rpc");
    await wait(() => pane().includes("已用 Chat 工具回复"), "原 TUI 回合完成");
    await wait(async () => {
      await runtimes.pump(agent.id);
      return runtimes.traces
        .page(agent.id)
        .items.some(
          (i) =>
            i.kind === "tool" && i.name === "mcp" && i.state === "complete",
        );
    }, "原 TUI 的真实工具轨迹");
    const traceBefore = runtimes.traces.page(agent.id).items;
    const bashTrace = traceBefore.find(
      (i) => i.kind === "tool" && i.name === "bash",
    );
    assert.equal(bashTrace?.state, "complete");
    assert.match(
      runtimes.traces.detail(agent.id, bashTrace.id).output,
      /BUSY_DONE/,
    );
    const capturedTrace = JSON.stringify(
      traceBefore.map((i) => runtimes.traces.detail(agent.id, i.id)),
      null,
      2,
    );
    writeFileSync(join(raw, "trace.json"), capturedTrace, { mode: 0o400 });
    hashes.push({ name: "trace.json", sha256: hash(capturedTrace) });
    const capture = pane();
    writeFileSync(join(raw, "tui.txt"), capture, { mode: 0o400 });
    hashes.push({ name: "tui.txt", sha256: hash(capture) });
    input("/new");
    await wait(async () => {
      await runtimes.pump(agent.id);
      return (
        !!runtimes.connections.get(agent.id) &&
        runtimes.connections.get(agent.id).info.sessionId !== before.sessionId
      );
    }, "用户主动切换会话");
    assert.equal(
      store.agent(agent.id).session_file,
      runtimes.connections.get(agent.id).info.sessionFile,
      "恢复位置未跟随用户主动切换的会话",
    );
    await wait(async () => {
      await runtimes.pump(agent.id);
      return runtimes.traces
        .page(agent.id)
        .items.some((i) => i.session_id !== before.sessionId);
    }, "新会话轨迹与既有记录衔接");
    assert(
      runtimes.traces.page(agent.id).items.some((i) => i.id === bashTrace.id),
      "换会话保留真实历史",
    );
    runtimes.connections.get(agent.id).connection.close();
    await wait(
      () => !runtimes.connections.has(agent.id),
      "模拟 TUI 仅连接断开",
    );
    await assert.rejects(runtimes.start(agent.id), /原 Pi 进程仍存在/);
    process.kill(before.pid, 0);
    const namedIdentity = await verifyIdentity({
      folder,
      profile,
      cwd,
      runtimes,
      store,
      baseUrl: `http://127.0.0.1:${port}`,
      wait,
      raw,
      hash,
      hashes,
    });
    const chatReply = store.timeline(chatId).items.at(-1);
    const events = await fetch(`http://127.0.0.1:${port}/api/events`);
    const reader = events.body.getReader();
    await reader.read();
    await app.close();
    await wait(async () => (await reader.read()).done, "SSE 在关闭时结束");
    process.kill(before.pid, 0);
    const report = {
      evidence: folder,
      test_kind: "real-pi-tui/local-deterministic-model",
      requests: requests.length,
      pid: before.pid,
      session_id: before.sessionId,
      session_file: before.sessionFile,
      tools_sha256: schemaHash,
      system_sha256: systemHash,
      chat_reply: chatReply,
      named_identity: namedIdentity,
      pi_version: execFileSync("pi", ["--version"], {
        encoding: "utf8",
      }).trim(),
      node_version: process.version,
      source_sha256: sourceHashes,
      checks: [
        "Atrium-ACP-pi-acp-native-runtime",
        "readonly-automatic-discovery",
        "temporary-runtime-does-not-create-identity",
        "legacy-identity-click-to-chat",
        "repeat-click-reuses-identity-and-chat",
        "create-and-start-in-one-action",
        "busy-MCP-attachment",
        "reject-duplicate-agent-binding",
        "custom-SYSTEM-preserved",
        "close-drains-gateway-and-SSE-without-killing-TUI",
        "hosted-rpc-autostart",
        "follow-user-session-switch",
        "disconnect-no-duplicate-process",
        "same-process",
        "same-session",
        "real-native-tool-trace-with-input-and-output",
        "trace-history-survives-real-session-replacement",
        "busy-tool-insertion",
        "real-fixed-mcp-call",
        "stable-short-chat-ref-in-mcp-call",
        "stable-tools",
        "stable-system",
        "appended-guide",
        "no-secret-in-context",
      ],
    };
    writeFileSync(join(folder, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  if (started) {
    try {
      writeFileSync(
        join(folder, "failed-tui.txt"),
        execFileSync(
          "tmux",
          ["capture-pane", "-p", "-t", session, "-S", "-1000"],
          { encoding: "utf8" },
        ),
      );
    } catch (captureError) {
      console.error("无法取得失败现场：", String(captureError));
    }
  }
  console.error(`证据保留：${folder}`);
  throw error;
} finally {
  if (started) {
    try {
      execFileSync("tmux", ["kill-session", "-t", session]);
    } catch {}
  }
  await app.close();
  await new Promise((resolve) => model.close(resolve));
  for (const [path, expected] of Object.entries(sourceHashes))
    assert.equal(
      hash(readFileSync(path)),
      expected,
      `源文件在验证中被改动：${path}`,
    );
  for (const entry of hashes)
    assert.equal(hash(readFileSync(join(raw, entry.name))), entry.sha256);
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(hashes, null, 2));
  chmodSync(raw, 0o500);
}
