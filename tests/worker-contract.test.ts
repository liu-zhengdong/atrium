import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eventTrail } from "./task-fixture.ts";
import { runContract, waitTask } from "./worker-contract.ts";

/**
 * 执行者契约（t271）：只靠档案（经接口写入，不改代码、不重启）接入假命令行工具，派活走通；
 * 出错标记、结束标记判结局；自定义模型端点经 opencode 的自定义 provider 传入，密钥按凭据名注入、不进日志。
 */

const KEY = "sk-corp-5d1f0e9b7c";

/** 假工具：把参数与环境记在任务目录，再照 body 输出。 */
const recorder = (body: string) =>
  [
    'printf "%s\\n" "$@" > "$PWD/../args-seen.txt"',
    'env > "$PWD/../env-seen.txt"',
    body,
  ].join("\n");

test("契约：只靠档案接入命令行工具，派活走通、提示词走参数、模型按参数组传", async (t) => {
  const { call, data, ref, run } = await runContract(t, {
    name: "fake-cli",
    profile: [
      "---",
      "protocol: cli",
      "command: fake-cli",
      'args: [run, "{model_args}", --cwd, "{cwd}", --, "{prompt}"]',
      'model_args: [--model, "{model}"]',
      "done_match: ^DONE$",
      "error_match: ^FATAL",
      "max_risk: high",
      "checks: []",
      "---",
      "假命令行工具：回一句话就行。",
    ].join("\n"),
    worker: "fake-cli+m1",
    script: recorder('echo working\necho "答复：好的"\necho DONE'),
  });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const task = await waitTask(call, ref);
  assert.equal(task.status, "done", eventTrail(task));
  const dir = join(data, "tasks", ref.slice(1));
  const args = readFileSync(join(dir, "args-seen.txt"), "utf8").split("\n");
  assert.deepEqual(args.slice(0, 5), [
    "run",
    "--model",
    "m1",
    "--cwd",
    join(dir, "work"),
  ]);
  assert.equal(args[5], "--");
  // 提示词整段是最后一个参数（多行）；档案正文只写工具事实，不附进提示词。
  assert.match(args.slice(6).join("\n"), /契约：fake-cli[\s\S]*按说明回一句话/);
  assert.doesNotMatch(args.slice(6).join("\n"), /假命令行工具：回一句话就行/);
  const env = readFileSync(join(dir, "env-seen.txt"), "utf8");
  assert.match(env, /^ATRIUM_WORKER=1$/m);
  assert.match(task.result ?? "", /答复：好的/);
  const log = readFileSync(join(dir, "log"), "utf8");
  assert.match(log, /\[atrium\] .*fake-cli\+m1/);
});

test("契约：命中出错标记、没见到结束标记都判失败；提示词走标准输入", async (t) => {
  for (const [body, pattern] of [
    [
      'echo \'{"type":"step"}\'\necho \'{"type":"error","message":"模型超时"}\'',
      /出错标记.*模型超时/,
    ],
    ['echo \'{"type":"step"}\'', /没见到结束标记/],
  ] as const) {
    const { call, data, ref, run } = await runContract(t, {
      name: "fake-jsonl",
      profile: [
        "---",
        "protocol: cli",
        "command: fake-jsonl",
        "output: jsonl",
        'done_match: \'"type":"done"\'',
        'error_match: \'"type":"error"\'',
        "max_risk: high",
        "---",
      ].join("\n"),
      script: `cat > "$PWD/../stdin-seen.txt"\n${body}`,
    });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    const task = await waitTask(call, ref);
    assert.equal(task.status, "failed", eventTrail(task));
    assert.match(
      readFileSync(join(data, "tasks", ref.slice(1), "stdin-seen.txt"), "utf8"),
      /契约：fake-jsonl/,
    );
    assert.match(
      task.events.map((event) => event.detail ?? "").join("\n"),
      pattern,
    );
  }
});

test("契约：写坏的档案经接口写不进去，派活认不得这个名字", async (t) => {
  const { app, call } = await runContract(t, {
    name: "fake-ok",
    profile: "---\nprotocol: cli\ncommand: fake-ok\nmax_risk: high\n---\n",
    script: "cat > /dev/null\necho ok",
  });
  const response = await app.inject({
    method: "PUT",
    url: "/api/workers/profiles/harness/fake-bad",
    headers: { host: "127.0.0.1" },
    payload: {
      source: '---\nprotocol: cli\ncommand: fake-bad\nargs: ["{nope}"]\n---\n',
    },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body, /\{nope\} 不是占位/);
  const created = await call("POST", "/api/tasks", {
    title: "认不得",
    deliver: "none",
  });
  const run = await call("POST", `/api/tasks/${created.body.ref}/run`, {
    worker: "fake-bad",
  });
  assert.equal(run.status, 400);
  assert.match(JSON.stringify(run.body), /未知的执行者工具：fake-bad.*fake-ok/);
});

test("自定义端点：opencode 经自定义 provider 接 OpenAI 兼容地址，密钥按凭据名注入且不进日志", async (t) => {
  const { app, call, data, ref, run } = await runContract(t, {
    name: "unused-cli",
    profile: "---\nprotocol: cli\ncommand: unused-cli\n---\n",
    worker: "opencode+deepseek-v4",
    extra: {
      "models/deepseek-v4":
        "---\nendpoint: http://127.0.0.1:9/v1\nendpoint_key: CORP_LLM_KEY\nchecks: []\nmax_risk: high\n---\n",
    },
    tweak: (fx) =>
      fx.script(
        "opencode",
        recorder(
          'echo \'{"type":"step_start","part":{}}\'\necho \'{"type":"text","part":{"text":"ok"}}\'\necho \'{"type":"step_finish","part":{"reason":"stop"}}\'',
        ),
      ),
  });
  // 凭据还没设：拉起前就拒绝，说清楚缺的是端点密钥。
  assert.equal(run.status, 409, JSON.stringify(run.body));
  assert.match(
    JSON.stringify(run.body),
    /CORP_LLM_KEY.*执行者 opencode\+deepseek-v4 的端点密钥/,
  );
  await call("POST", "/api/org/nodes", {
    slug: "org",
    kind: "org",
    name: "组织",
    reason: "建",
  });
  const set = await app.inject({
    method: "PUT",
    url: "/api/secrets",
    headers: { host: "127.0.0.1" },
    payload: { node: "o1", name: "CORP_LLM_KEY", value: KEY },
  });
  assert.ok(set.statusCode < 300, set.body);
  const again = await call("POST", `/api/tasks/${ref}/run`, {
    worker: "opencode+deepseek-v4",
  });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const task = await waitTask(call, ref);
  assert.equal(task.status, "done", eventTrail(task));
  const dir = join(data, "tasks", ref.slice(1));
  const args = readFileSync(join(dir, "args-seen.txt"), "utf8");
  assert.match(args, /^-m\natrium\/deepseek-v4$/m);
  const env = readFileSync(join(dir, "env-seen.txt"), "utf8");
  assert.ok(env.split("\n").includes(`CORP_LLM_KEY=${KEY}`));
  const config = env
    .split("\n")
    .find((line) => line.startsWith("OPENCODE_CONFIG_CONTENT="))!;
  assert.deepEqual(
    JSON.parse(config.slice("OPENCODE_CONFIG_CONTENT=".length)).provider.atrium
      .options,
    { baseURL: "http://127.0.0.1:9/v1", apiKey: "{env:CORP_LLM_KEY}" },
  );
  const log = readFileSync(join(dir, "log"), "utf8");
  assert.ok(!log.includes(KEY), "密钥进了日志");
  assert.match(log, /OPENCODE_CONFIG_CONTENT=.*\{env:CORP_LLM_KEY\}/);
  assert.match(
    task.events.map((e) => `${e.kind} ${e.detail}`).join("\n"),
    /secrets_injected .*CORP_LLM_KEY/,
  );
  assert.ok(
    !task.events.some((e) => (e.detail ?? "").includes(KEY)),
    "密钥进了事件",
  );
});
