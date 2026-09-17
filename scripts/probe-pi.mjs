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
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createApp } from "../server/app.ts";

const folder = mkdtempSync(join(tmpdir(), "atrium-proof-"));
const profile = join(folder, "profile"),
  cwd = join(folder, "workspace"),
  raw = join(folder, "raw");
for (const dir of [profile, cwd, raw]) mkdirSync(dir, { mode: 0o700 });
process.env.PI_MCP_CONFIG_MODE = "exclusive";
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
    assert(requests.length <= 10, "超出模型夹具请求预算");
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
                chat_id: chatId,
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
});
await app.listen({ port: 0, host: "127.0.0.1" });
const port = app.server.address().port;
let started = false;
try {
  const command = `env PI_CODING_AGENT_DIR=${shell(profile)} PI_MCP_TOOL_EXPOSURE=proxy-only PI_MCP_CONFIG_MODE=exclusive pi --extension ${shell(resolve("pi/extension.ts"))} --extension ${shell(readyExtension)}`;
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
  const response = await fetch(`http://127.0.0.1:${port}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "验证 Agent", cwd }),
  });
  assert.equal(response.status, 201);
  const { agent, link_path } = await response.json();
  const chat = store.createChat("原地接入验证", [agent.id]);
  chatId = chat.id;
  input(`/atrium-connect ${link_path}`);
  await wait(() => runtimes.connections.has(agent.id), "现有 TUI 原地连接");
  const before = structuredClone(runtimes.connections.get(agent.id).info);
  assert.equal(before.mode, "tui");
  const fileBefore = readFileSync(before.session_file, "utf8");
  assert(fileBefore.includes("ATR_BASELINE"));
  input("ATR_BUSY");
  await wait(
    () => existsSync(join(cwd, "started")),
    "原任务的真实 bash 工具正在执行",
  );
  store.send("user", {
    chat_id: chatId,
    body: "@验证 Agent ATR_INSERT：请通过 Chat 工具回复",
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
  assert.equal(before.session_id, after.session_id);
  assert.equal(before.session_file, after.session_file);
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
  const attached = requests.slice(1);
  assert(
    attached.some((r) =>
      JSON.stringify(r.messages).includes("Atrium 是你的聊天与事件入口"),
    ),
  );
  assert(
    !JSON.stringify(requests).includes(
      JSON.parse(readFileSync(link_path, "utf8")).token,
    ),
    "连接密钥泄漏到模型上下文",
  );
  assert(!modelError, String(modelError));
  const rpcResponse = await fetch(`http://127.0.0.1:${port}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "后台验证 Agent", cwd }),
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
  await wait(() => runtimes.connections.has(rpcAgent.id), "后台 Pi 启动并连接");
  assert.equal(runtimes.connections.get(rpcAgent.id).info.mode, "rpc");
  await wait(() => pane().includes("已用 Chat 工具回复"), "原 TUI 回合完成");
  const capture = pane();
  writeFileSync(join(raw, "tui.txt"), capture, { mode: 0o400 });
  hashes.push({ name: "tui.txt", sha256: hash(capture) });
  input("/new");
  await wait(async () => {
    await runtimes.pump(agent.id);
    return (
      !!runtimes.connections.get(agent.id) &&
      runtimes.connections.get(agent.id).info.session_id !== before.session_id
    );
  }, "用户主动切换会话");
  assert.equal(
    store.agent(agent.id).session_file,
    runtimes.connections.get(agent.id).info.session_file,
    "恢复位置未跟随用户主动切换的会话",
  );
  runtimes.connections.get(agent.id).connection.close();
  await wait(() => !runtimes.connections.has(agent.id), "模拟 TUI 仅连接断开");
  assert.throws(() => runtimes.start(agent.id), /原 Pi 进程仍存在/);
  const report = {
    evidence: folder,
    test_kind: "real-pi-tui/local-deterministic-model",
    requests: requests.length,
    pid: before.pid,
    session_id: before.session_id,
    session_file: before.session_file,
    tools_sha256: schemaHash,
    system_sha256: systemHash,
    chat_reply: store.timeline(chatId).items.at(-1),
    pi_version: execFileSync("pi", ["--version"], { encoding: "utf8" }).trim(),
    node_version: process.version,
    source_sha256: Object.fromEntries(
      [
        "pi/extension.ts",
        "server/app.ts",
        "server/runtime.ts",
        "server/store.ts",
        "shared/runtime-mode.ts",
      ].map((path) => [path, hash(readFileSync(resolve(path)))]),
    ),
    checks: [
      "hosted-rpc-autostart",
      "follow-user-session-switch",
      "disconnect-no-duplicate-process",
      "same-process",
      "same-session",
      "busy-tool-insertion",
      "real-fixed-mcp-call",
      "stable-tools",
      "stable-system",
      "appended-guide",
      "no-secret-in-context",
    ],
  };
  writeFileSync(join(folder, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
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
  for (const entry of hashes)
    assert.equal(hash(readFileSync(join(raw, entry.name))), entry.sha256);
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(hashes, null, 2));
  chmodSync(raw, 0o500);
}
