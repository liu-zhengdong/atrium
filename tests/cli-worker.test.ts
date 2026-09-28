import { test } from "node:test";
import assert from "node:assert/strict";
import { cliAdapter, expandArgs, expandEnv } from "../server/tasks/adapters/cli.ts";
import { cliAdopted, cliEnding } from "../server/tasks/adapters/cli-outcome.ts";
import { parseCliSpec, type CliSpec } from "../server/tasks/adapters/cli-spec.ts";
import { parseProfileSource } from "../server/tasks/profiles.ts";

/**
 * 通用命令行执行者（t271）：档案写法解析、参数与环境展开、提示词三种给法、端点、结局判定，纯函数穷举。
 * 真派活走一遍见 worker-contract.test.ts。
 */

const rulesOf = (front: string) =>
  parseProfileSource(`---\n${front}\n---\n`).rules;

const specOf = (front: string, name = "mytool") => {
  const { spec, problems } = parseCliSpec(name, rulesOf(front));
  assert.deepEqual(problems, []);
  return spec!;
};

const input = {
  promptFile: "/tmp/t1/prompt.md",
  prompt: "修一个 bug",
  cwd: "/w/repo-t1-x",
};

test("档案写法：最小一份与各键的缺省", () => {
  const spec = specOf('protocol: cli\ncommand: mytool\nargs: [run, "{prompt}"]');
  assert.deepEqual(spec, {
    command: "mytool",
    args: ["run", "{prompt}"],
    groups: { model_args: [], effort_args: [], endpoint_args: [] },
    output: "text",
    env: {},
    endpointApis: [],
    exclusive: false,
    quotaProvider: "mytool",
    promptVia: "arg",
  });
  assert.equal(
    specOf('protocol: cli\ncommand: mytool\nargs: [--file, "{prompt_file}"]')
      .promptVia,
    "file",
  );
  assert.equal(specOf("protocol: cli\ncommand: mytool").promptVia, "stdin");
  const full = specOf(
    [
      "protocol: cli",
      "command: company-agent",
      'args: [exec, "{model_args}", "{effort_args}", "{endpoint_args}", --cwd, "{cwd}", --, "{prompt}"]',
      'model_args: [-m, "{model}"]',
      'effort_args: ["--effort={effort}"]',
      'endpoint_args: [--base-url, "{base_url}"]',
      "efforts: [low, high]",
      "output: jsonl",
      'done_match: \'"type":"done"\'',
      "error_match: '^ERROR'",
      'env: {AGENT_MODEL: "{model}", AGENT_LOG: quiet}',
      "endpoint_apis: [openai, anthropic]",
      "key_env: AGENT_API_KEY",
      "exclusive: true",
      "quota_provider: corp",
    ].join("\n"),
    "company-agent",
  );
  assert.deepEqual(
    {
      efforts: full.efforts,
      output: full.output,
      done: full.done,
      error: full.error,
      env: full.env,
      endpointApis: full.endpointApis,
      keyEnv: full.keyEnv,
      exclusive: full.exclusive,
      quotaProvider: full.quotaProvider,
    },
    {
      efforts: ["low", "high"],
      output: "jsonl",
      done: '"type":"done"',
      error: "^ERROR",
      env: { AGENT_MODEL: "{model}", AGENT_LOG: "quiet" },
      endpointApis: ["openai", "anthropic"],
      keyEnv: "AGENT_API_KEY",
      exclusive: true,
      quotaProvider: "corp",
    },
  );
  // 用了 {base_url} 没写 endpoint_apis：缺省只接 openai。
  assert.deepEqual(
    specOf('protocol: cli\ncommand: t\nargs: ["--url={base_url}"]', "t")
      .endpointApis,
    ["openai"],
  );
});

test("档案写法：每种毛病都说清楚、不登记", () => {
  const cases: [string, RegExp, string?][] = [
    ["protocol: acp\ncommand: t", /protocol 只能是 cli.*ACP 执行者还没接入/],
    ["protocol: x\ncommand: t", /protocol 只能是 cli/],
    ["protocol: cli", /command 须写 PATH 上的命令名/],
    ["protocol: cli\ncommand: /usr/bin/t", /不带路径/],
    ["protocol: cli\ncommand: 'my tool'", /不带路径、空白/],
    ["protocol: cli\ncommand: -x", /不带路径/],
    ["protocol: cli\ncommand: t\nargs: [{prompt}]", /占位要加引号/],
    ["protocol: cli\ncommand: t\nargs: [\"{foo}\"]", /\{foo\} 不是占位/],
    [
      'protocol: cli\ncommand: t\nargs: ["--m={model_args}"]',
      /\{model_args\} 只能在 args 里单独占一项/,
    ],
    [
      'protocol: cli\ncommand: t\nmodel_args: [-m, "{model}"]',
      /写了 model_args，但 args 里没有 \{model_args\}/,
    ],
    [
      'protocol: cli\ncommand: t\nargs: ["{model_args}"]\nmodel_args: ["{effort_args}"]',
      /只能在 args 里单独占一项/,
    ],
    ["protocol: cli\ncommand: t\nefforts: [low]", /写了 efforts，但 args 里没用/],
    ['protocol: cli\ncommand: t\nargs: ["{effort}"]', /没写 efforts/],
    [
      'protocol: cli\ncommand: t\nargs: ["{effort}"]\nefforts: [Low]',
      /小写字母/,
    ],
    ["protocol: cli\ncommand: t\noutput: xml", /output 只能是 text 或 jsonl/],
    ["protocol: cli\ncommand: t\ndone_match: '('", /done_match 不是合法正则/],
    ["protocol: cli\ncommand: t\nerror_match: ''", /error_match 须是非空正则/],
    ["protocol: cli\ncommand: t\nenv: [a]", /env 须写成/],
    ["protocol: cli\ncommand: t\nenv: {PATH: x}", /env\.PATH：.*本来就有/],
    ["protocol: cli\ncommand: t\nenv: {ATRIUM_X: x}", /ATRIUM_\*/],
    [
      'protocol: cli\ncommand: t\nenv: {A_B: "{prompt}"}',
      /只能用 \{model\}、\{base_url\}/,
    ],
    [
      'protocol: cli\ncommand: t\nargs: ["{base_url}"]\nendpoint_apis: [grpc]',
      /grpc 不认识/,
    ],
    [
      'protocol: cli\ncommand: t\nargs: ["{base_url}"]\nkey_env: path',
      /key_env：/,
    ],
    ["protocol: cli\ncommand: t\nkey_env: A_KEY", /没用 \{base_url\}/],
    ["protocol: cli\ncommand: t\nexclusive: yes", /exclusive 只能是/],
    ["protocol: cli\ncommand: t\nquota_provider: 'a b'", /quota_provider/],
    [
      'protocol: cli\ncommand: t\nargs: ["{prompt}", "{prompt_file}"]',
      /只用一个/,
    ],
    ["protocol: cli\ncommand: t", /工具名 Bad 不合法/, "Bad"],
  ];
  for (const [front, pattern, name] of cases) {
    const { spec, problems } = parseCliSpec(name ?? "t", rulesOf(front));
    assert.equal(spec, undefined, front);
    assert.match(problems.join("；"), pattern, front);
  }
});

const full: CliSpec = specOf(
  [
    "protocol: cli",
    "command: agent",
    'args: [exec, "{model_args}", "{effort_args}", "{endpoint_args}", --cwd, "{cwd}", --, "{prompt}"]',
    'model_args: [-m, "{model}"]',
    'effort_args: ["--effort={effort}"]',
    'endpoint_args: [--base-url, "{base_url}"]',
    "efforts: [low, high]",
    'env: {AGENT_MODEL: "{model}", AGENT_URL: "{base_url}", AGENT_LOG: quiet}',
    "endpoint_apis: [openai]",
    "key_env: AGENT_API_KEY",
  ].join("\n"),
  "agent",
);

test("参数展开：整组在缺值时省掉，缺值的单个占位报错", () => {
  assert.deepEqual(expandArgs("agent", full, { prompt: "p", cwd: "/w" }), [
    "exec",
    "--cwd",
    "/w",
    "--",
    "p",
  ]);
  assert.deepEqual(
    expandArgs("agent", full, {
      prompt: "p",
      cwd: "/w",
      model: "glm-4.6",
      effort: "high",
      base_url: "http://llm.corp/v1",
    }),
    [
      "exec",
      "-m",
      "glm-4.6",
      "--effort=high",
      "--base-url",
      "http://llm.corp/v1",
      "--cwd",
      "/w",
      "--",
      "p",
    ],
  );
  const direct = specOf('protocol: cli\ncommand: t\nargs: [-m, "{model}"]', "t");
  assert.throws(
    () => expandArgs("t", direct, {}),
    /t 的档案 args 用了 \{model\}，但这次没有模型.*model_args/,
  );
  assert.deepEqual(expandEnv(full, { model: "glm" }), {
    AGENT_MODEL: "glm",
    AGENT_LOG: "quiet",
  });
});

test("适配器：提示词走参数、文件或标准输入；强度与端点按档案查", () => {
  const agent = cliAdapter("agent", full);
  assert.equal(agent.tool, "agent");
  assert.equal(agent.executable, "agent");
  assert.equal(agent.tell, "restart");
  assert.deepEqual(agent.progressSignals, ["log_growth", "worktree_change"]);
  assert.deepEqual(agent.defaultRules, { trust: "unknown", max_risk: "low" });
  assert.deepEqual(agent.endpoints, {
    apis: ["openai"],
    keyEnv: "AGENT_API_KEY",
  });
  assert.deepEqual(
    agent.build({
      ...input,
      model: "glm-4.6",
      endpoint: {
        base_url: "http://llm.corp/v1",
        api: "openai",
        keyEnv: "AGENT_API_KEY",
      },
    }),
    {
      command: "agent",
      args: [
        "exec",
        "-m",
        "glm-4.6",
        "--base-url",
        "http://llm.corp/v1",
        "--cwd",
        input.cwd,
        "--",
        input.prompt,
      ],
      cwd: input.cwd,
      env: {
        AGENT_MODEL: "glm-4.6",
        AGENT_URL: "http://llm.corp/v1",
        AGENT_LOG: "quiet",
      },
    },
  );
  assert.throws(
    () => agent.build({ ...input, effort: "max" }),
    /agent 的思考强度只能是 low、high/,
  );
  assert.throws(
    () =>
      agent.build({
        ...input,
        endpoint: { base_url: "http://x/v1", api: "anthropic" },
      }),
    /agent 只能接 openai 接口的端点，这个端点是 anthropic/,
  );
  assert.throws(() => agent.build({ ...input, prompt: " " }), /提示词为空/);
  const stdin = cliAdapter("t", specOf("protocol: cli\ncommand: t", "t"));
  assert.deepEqual(stdin.build(input), {
    command: "t",
    args: [],
    cwd: input.cwd,
    stdin: input.promptFile,
  });
  assert.throws(() => stdin.build({ ...input, effort: "low" }), /不支持指定思考强度/);
  assert.throws(
    () =>
      stdin.build({
        ...input,
        endpoint: { base_url: "http://x/v1", api: "openai" },
      }),
    /t 不支持自定义模型端点/,
  );
  const file = cliAdapter(
    "t",
    specOf('protocol: cli\ncommand: t\nargs: [--file, "{prompt_file}"]', "t"),
  );
  assert.deepEqual(file.build(input), {
    command: "t",
    args: ["--file", input.promptFile],
    cwd: input.cwd,
  });
});

test("结局：出错标记、结束标记、接管后按日志判", () => {
  const rules = { output: "text" as const, done: "^DONE", error: "^FATAL" };
  assert.equal(cliEnding(rules, "working\nDONE\n"), undefined);
  assert.deepEqual(cliEnding(rules, "working\nFATAL: 连不上模型\nDONE"), {
    kind: "error",
    reason: "日志命中出错标记（error_match）：FATAL: 连不上模型",
  });
  assert.equal(cliEnding(rules, "working\n")?.kind, "midway");
  assert.equal(cliEnding({ output: "text" }, "随便什么"), undefined);
  assert.equal(
    cliEnding({ output: "text", error: "x" }, "x".repeat(300))?.reason.length,
    "日志命中出错标记（error_match）：".length + 198,
  );
  assert.deepEqual(cliAdopted(rules, "DONE"), {
    end: "clean",
    evidence: "见到了结束标记",
  });
  assert.deepEqual(cliAdopted(rules, "FATAL x\nDONE"), {
    end: "error",
    evidence: "命中出错标记：FATAL x",
  });
  assert.deepEqual(cliAdopted(rules, "working"), {
    end: "error",
    evidence: "没见到结束标记",
  });
  assert.deepEqual(cliAdopted({ output: "text" }, "working"), {
    end: "unknown",
  });
  assert.deepEqual(cliAdopted(rules, undefined), { end: "unknown" });
});
