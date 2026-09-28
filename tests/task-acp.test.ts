import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { syncCustomTools } from "../server/tasks/adapters/custom.ts";
import { profileDb } from "./profile-fixture.ts";
import { eventTrail, startApp, until } from "./task-fixture.ts";

/**
 * 只靠档案接入 ACP 工具（#418）：经 `PUT /api/workers/profiles/harness/<名字>`（即 `atrium workers edit`）写档案，
 * 不改代码就能派活；进度、结果、捎话、选模型经 ACP 桥走通，写错的档案当场拒绝。
 */

const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-worker.mjs");
const slash = (path: string) => path.replaceAll("\\", "/");
const PROFILE = `---
protocol: acp
command: "${slash(process.execPath)}"
args: ["${slash(FAKE)}"]
model: fake-small
efforts: [low, high]
checks: []
---
假 ACP 执行者的叮嘱
`;

type App = Awaited<ReturnType<typeof startApp>>["app"];

/** 改档案（`atrium workers edit <层/名> --file` 的接口）。 */
async function putProfile(app: App, ref: string, source: string) {
  const response = await app.inject({
    method: "PUT",
    url: `/api/workers/profiles/${ref}`,
    headers: { host: "127.0.0.1" },
    payload: { source },
  });
  return { status: response.statusCode, body: response.json() };
}

async function register(app: App) {
  const response = await putProfile(app, "harness/fakeacp", PROFILE);
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

test("派活：档案接入的 ACP 工具跑完一件任务，摘要取最后的回复，日志按 claude stream-json 写", async (t) => {
  const { data, call, app } = await startApp(t);
  t.after(() => syncCustomTools(profileDb(), () => {}));
  await register(app);
  const listed = await call("GET", "/api/workers/profiles");
  assert.ok(
    listed.body.profiles.some(
      (row: { ref: string; protocol: string }) =>
        row.ref === "harness/fakeacp" && row.protocol === "acp",
    ),
  );
  await call("POST", "/api/tasks", { title: "ACP 小活", deliver: "none" });
  const run = await call("POST", "/api/tasks/t1/run", {
    worker: "fakeacp+fake-large:high",
  });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const done = await call("GET", "/api/tasks/t1/wait?timeout=30");
  assert.equal(done.body.task.status, "done", eventTrail(done.body.task));
  assert.match(done.body.task.result, /^收到：/);
  assert.match(done.body.task.result, /模型 fake-large，强度 high/);
  const log = readFileSync(join(data, "tasks", "1", "log"), "utf8");
  assert.match(log, /--tool fakeacp --input stream-json --permissions allow/);
  assert.match(log, /"subtype":"init","session_id":"w-1","tool":"fakeacp"/);
  assert.match(log, /"type":"tool_use","id":"[^"]+","name":"bash"/);
  assert.match(log, /"type":"result","subtype":"success","is_error":false/);
});

test("捎话：运行中 task tell 走标准输入，桥排到本轮之后作为追加消息送进会话，回显后记为已送达", async (t) => {
  const { data, call, app } = await startApp(t);
  t.after(() => syncCustomTools(profileDb(), () => {}));
  await register(app);
  await call("POST", "/api/tasks", { title: "慢活 SLOW", deliver: "none" });
  await call("POST", "/api/tasks/t1/run", { worker: "fakeacp" });
  const log = join(data, "tasks", "1", "log");
  await until(() => {
    try {
      return readFileSync(log, "utf8").includes('"tool_use"');
    } catch {
      return false;
    }
  }, 20_000);
  const told = await call("POST", "/api/tasks/t1/tell", { text: "改用 v2" });
  assert.equal(told.status, 200, JSON.stringify(told.body));
  assert.equal(told.body.tell.route, "stdin");
  assert.match(told.body.how, /本轮做完后接着作为下一轮读入/);
  const done = await call("GET", "/api/tasks/t1/wait?timeout=30");
  assert.equal(done.body.task.status, "done", eventTrail(done.body.task));
  const tell = done.body.task.events
    .filter((event: { kind: string }) => event.kind === "tell")
    .map((event: { detail: string }) => JSON.parse(event.detail))[0];
  assert.equal(tell.state, "delivered");
  assert.equal(tell.delivered_via, "stdin");
  assert.match(
    done.body.task.result,
    /^收到：补充说明（u1 · [^）]+）：\n\n改用 v2/,
    "摘要是第二轮（捎话）的回复",
  );
  const text = readFileSync(log, "utf8");
  assert.equal(text.match(/"type":"result"/g)?.length, 1);
});

test("档案校验：内置工具不能改协议、新工具要写 protocol 与 command、接入字段只写在工具层；写错的派不了", async (t) => {
  const { call, app } = await startApp(t);
  t.after(() => syncCustomTools(profileDb(), () => {}));
  const cases: [string, string, string, RegExp][] = [
    [
      "harness",
      "claude",
      "---\nprotocol: acp\ncommand: claude\n---\n",
      /内置工具，不能写 protocol、command/,
    ],
    [
      "harness",
      "pi",
      "---\nmodel: glm-5\n---\n",
      /须写 protocol: acp 与 command/,
    ],
    [
      "harness",
      "pi",
      "---\nprotocol: acp\ncommand: pi\nmodel_args: [--model]\n---\n",
      /model_args 里须有 \{model\}/,
    ],
    [
      "models",
      "glm-5",
      "---\ncommand: pi\n---\n",
      /command 只能写在工具层档案/,
    ],
    ["harness", "Pi", "---\nprotocol: acp\ncommand: pi\n---\n", /工具层档案名/],
  ];
  for (const [layer, name, source, pattern] of cases) {
    const response = await putProfile(app, `${layer}/${name}`, source);
    assert.equal(response.status, 400, `${layer}/${name}`);
    assert.match(response.body.error, pattern, `${layer}/${name}`);
  }
  await call("POST", "/api/tasks", { title: "派给没接入的", deliver: "none" });
  const run = await call("POST", "/api/tasks/t1/run", { worker: "pi" });
  assert.equal(run.status, 400);
  assert.match(run.body.error, /未知的执行者工具：pi/);
  await register(app);
  const effort = await call("POST", "/api/tasks/t1/run", {
    worker: "fakeacp:max",
  });
  assert.equal(effort.status, 400);
  assert.match(effort.body.error, /思考强度只能是 low、high/);
});
