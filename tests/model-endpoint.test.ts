import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTERS,
  endpointProblem,
  isTool,
  TOOLS,
} from "../server/tasks/adapters/index.ts";
import {
  endpointFit,
  endpointKey,
  endpointOf,
  endpointRuleProblem,
  launchEndpoint,
} from "../server/tasks/endpoint.ts";
import { parseProfileSource, resolveWorker } from "../server/tasks/profiles.ts";
import { editProfile } from "../server/tasks/worker-profile-edit.ts";
import { writeProfile } from "../server/tasks/worker-profiles.ts";
import { loadCustomTools } from "../server/tasks/custom-tools.ts";
import { profileDb } from "./profile-fixture.ts";

/**
 * 自定义模型端点（t271）：档案规则校验、各工具怎么接（opencode 自定义 provider、codex 配置覆盖、
 * claude 的 Anthropic 兼容网关、通用命令行执行者的模板）、接不了的在改档案与派活前说清楚、密钥注入成哪个变量。
 */

const input = {
  promptFile: "/tmp/t1/prompt.md",
  prompt: "修一个 bug",
  cwd: "/w/repo-t1-x",
};
const URL_ = "http://llm.corp:8000/v1";

test("端点规则：地址、接口种类、凭据名逐条校验；写错的不生效", () => {
  assert.equal(endpointRuleProblem("endpoint", URL_), null);
  assert.equal(endpointRuleProblem("endpoint", "https://x.example/api"), null);
  for (const [value, pattern] of [
    [3, /须是地址/],
    ["llm.corp/v1", /不是合法地址/],
    ["ftp://x/v1", /只能是 http 或 https/],
    ["http://u:p@x/v1", /不要带用户名、密码或查询参数/],
    ["http://x/v1?key=abc", /不要带用户名、密码或查询参数/],
  ] as const)
    assert.match(
      endpointRuleProblem("endpoint", value)!,
      pattern,
      String(value),
    );
  for (const api of ["openai", "responses", "anthropic"])
    assert.equal(endpointRuleProblem("endpoint_api", api), null);
  assert.match(
    endpointRuleProblem("endpoint_api", "grpc")!,
    /只能是 openai、responses、anthropic/,
  );
  assert.equal(endpointRuleProblem("endpoint_key", "GLM_API_KEY"), null);
  assert.match(
    endpointRuleProblem("endpoint_key", "glm")!,
    /endpoint_key：.*大写字母开头/,
  );
  assert.match(endpointRuleProblem("endpoint_key", "PATH")!, /本来就有/);
  assert.match(endpointRuleProblem("endpoint_key", "ATRIUM_KEY")!, /ATRIUM_\*/);
  const parsed = parseProfileSource(
    "---\nendpoint: http://u:p@x/v1\nendpoint_api: grpc\nendpoint_key: glm\n---\n",
  );
  assert.equal(parsed.rules.endpoint, undefined);
  assert.equal(parsed.rules.endpoint_api, undefined);
  assert.equal(parsed.rules.endpoint_key, undefined);
  assert.equal(parsed.warnings.length, 3);
});

test("取端点：没写地址不算；接口缺省 openai；密钥可不写", () => {
  assert.equal(endpointOf({ endpoint_key: "K" }), undefined);
  assert.deepEqual(endpointOf({ endpoint: URL_ }), {
    base_url: URL_,
    api: "openai",
  });
  assert.deepEqual(
    endpointOf({
      endpoint: URL_,
      endpoint_api: "anthropic",
      endpoint_key: "K",
    }),
    { base_url: URL_, api: "anthropic", key: "K" },
  );
});

test("各工具能不能接：内置三个各接各的，其余说清楚换谁", () => {
  const ok: [string, string][] = [
    ["opencode", "openai"],
    ["opencode", "anthropic"],
    ["codex", "responses"],
    ["claude", "anthropic"],
  ];
  for (const tool of TOOLS)
    for (const api of ["openai", "responses", "anthropic"] as const) {
      const problem = endpointProblem(ADAPTERS[tool]!, api);
      if (ok.some(([t, a]) => t === tool && a === api))
        assert.equal(problem, null, `${tool} ${api}`);
      else assert.ok(problem, `${tool} ${api}`);
    }
  assert.match(
    endpointProblem(ADAPTERS.grok!, "openai")!,
    /grok 不支持自定义模型端点；能接的内置工具：opencode.*通用命令行执行者/,
  );
  assert.match(
    endpointProblem(ADAPTERS.codex!, "openai")!,
    /codex 只能接 responses.*codex 已不支持 Chat Completions/,
  );
  assert.equal(endpointFit(ADAPTERS.kimi!, {}), null);
  assert.match(endpointFit(ADAPTERS.kimi!, { endpoint: URL_ })!, /kimi 不支持/);
});

test("密钥注入成哪个变量：claude 固定 ANTHROPIC_AUTH_TOKEN，其余用凭据名本身", () => {
  const endpoint = { base_url: URL_, api: "anthropic" as const, key: "GW_KEY" };
  assert.deepEqual(launchEndpoint(ADAPTERS.claude!, endpoint), {
    launch: {
      base_url: URL_,
      api: "anthropic",
      keyEnv: "ANTHROPIC_AUTH_TOKEN",
    },
    key: { name: "GW_KEY", as: "ANTHROPIC_AUTH_TOKEN" },
  });
  assert.deepEqual(launchEndpoint(ADAPTERS.opencode!, endpoint), {
    launch: { base_url: URL_, api: "anthropic", keyEnv: "GW_KEY" },
    key: { name: "GW_KEY", as: "GW_KEY" },
  });
  assert.deepEqual(
    launchEndpoint(ADAPTERS.opencode!, { base_url: URL_, api: "openai" }),
    { launch: { base_url: URL_, api: "openai" } },
  );
});

test("opencode：自定义 provider 经 OPENCODE_CONFIG_CONTENT，密钥写成 {env:变量}", () => {
  const launch = ADAPTERS.opencode!.build({
    ...input,
    model: "deepseek-v4",
    endpoint: { base_url: URL_, api: "openai", keyEnv: "GLM_API_KEY" },
  });
  assert.deepEqual(launch.args, [
    "run",
    "--format",
    "json",
    "--auto",
    "-m",
    "atrium/deepseek-v4",
    "--",
    input.prompt,
  ]);
  assert.deepEqual(JSON.parse(launch.env!.OPENCODE_CONFIG_CONTENT!), {
    provider: {
      atrium: {
        npm: "@ai-sdk/openai-compatible",
        name: "Atrium 自定义端点",
        options: { baseURL: URL_, apiKey: "{env:GLM_API_KEY}" },
        models: { "deepseek-v4": { name: "deepseek-v4" } },
      },
    },
  });
  const anthropic = ADAPTERS.opencode!.build({
    ...input,
    model: "m",
    endpoint: { base_url: URL_, api: "anthropic" },
  });
  const config = JSON.parse(anthropic.env!.OPENCODE_CONFIG_CONTENT!);
  assert.equal(config.provider.atrium.npm, "@ai-sdk/anthropic");
  assert.deepEqual(config.provider.atrium.options, { baseURL: URL_ });
  assert.throws(
    () =>
      ADAPTERS.opencode!.build({
        ...input,
        endpoint: { base_url: URL_, api: "openai" },
      }),
    /要写模型名/,
  );
  // 没写端点的调用与以前一样。
  assert.equal(ADAPTERS.opencode!.build(input).env, undefined);
});

test("codex：配置覆盖加一个 Responses 接口的 model_provider，续上会话也带上", () => {
  const endpoint = {
    base_url: URL_,
    api: "responses" as const,
    keyEnv: "CORP_KEY",
  };
  const flags = [
    "-c",
    'model_provider="atrium"',
    "-c",
    'model_providers.atrium.name="Atrium 自定义端点"',
    "-c",
    `model_providers.atrium.base_url="${URL_}"`,
    "-c",
    'model_providers.atrium.wire_api="responses"',
    "-c",
    'model_providers.atrium.env_key="CORP_KEY"',
  ];
  const built = ADAPTERS.codex!.build({ ...input, model: "qwen3", endpoint });
  const at = built.args.indexOf("-o");
  assert.deepEqual(built.args.slice(at - flags.length, at), flags);
  const resumed = ADAPTERS.codex!.resume!({
    ...input,
    endpoint,
    session: "0199a213-81c0-7800-8aa1-bbab2a035a53",
  });
  assert.ok(resumed.args.join(" ").includes(flags.join(" ")));
  assert.throws(
    () =>
      ADAPTERS.codex!.build({
        ...input,
        endpoint: { base_url: URL_, api: "openai" },
      }),
    /codex 只能接 responses/,
  );
});

test("claude：Anthropic 兼容网关走 ANTHROPIC_BASE_URL，密钥不进参数与环境抬头", () => {
  const built = ADAPTERS.claude!.build({
    ...input,
    model: "glm-4.6",
    endpoint: {
      base_url: URL_,
      api: "anthropic",
      keyEnv: "ANTHROPIC_AUTH_TOKEN",
    },
  });
  assert.deepEqual(built.env, { ANTHROPIC_BASE_URL: URL_ });
  assert.ok(built.args.includes("glm-4.6"));
  assert.throws(
    () =>
      ADAPTERS.claude!.build({
        ...input,
        endpoint: { base_url: URL_, api: "openai" },
      }),
    /claude 只能接 anthropic/,
  );
});

test("改档案：接不了端点的工具、内置工具改协议、没写协议的新名字都拒绝；写对了即登记", async () => {
  const db = profileDb();
  const bad: [string, object, RegExp][] = [
    ["harness/grok", { set: { endpoint: URL_ } }, /grok 不支持自定义模型端点/],
    [
      "combos/codex+qwen3",
      { set: { endpoint: URL_, endpoint_api: "openai" } },
      /codex 只能接 responses/,
    ],
    [
      "models/glm-4.6",
      { set: { endpoint: "http://u:p@x/v1" } },
      /不要带用户名/,
    ],
    [
      "harness/opencode",
      { set: { protocol: "cli" } },
      /内置工具.*harness\/opencode-cli/,
    ],
    [
      "harness/corp-agent",
      { set: { trust: "low" } },
      /不是内置工具：写 protocol: cli/,
    ],
    [
      "harness/corp-agent",
      { set: { protocol: "cli", command: "/opt/agent" } },
      /不带路径/,
    ],
  ];
  for (const [ref, body, pattern] of bad)
    assert.throws(() => editProfile(db, ref, body, "u1"), pattern, ref);
  assert.equal(isTool("corp-agent"), false);
  // models 层不知道是哪个工具：先收下，派活前按工具查。
  editProfile(
    db,
    "models/glm-4.6",
    { set: { endpoint: URL_, endpoint_key: "GLM_API_KEY" } },
    "u1",
  );
  editProfile(
    db,
    "harness/corp-agent",
    {
      source:
        '---\nprotocol: cli\ncommand: corp-agent\nargs: ["{model_args}", "{endpoint_args}", "{prompt}"]\nmodel_args: [-m, "{model}"]\nendpoint_args: [--url, "{base_url}"]\nkey_env: CORP_API_KEY\n---\n公司自己的工具。\n',
    },
    "u1",
  );
  assert.equal(isTool("corp-agent"), true);
  const worker = await resolveWorker("corp-agent+glm-4.6", db);
  assert.equal(worker.tool, "corp-agent");
  assert.equal(worker.profile.rules.trust, "unknown");
  assert.equal(worker.profile.rules.max_risk, "low");
  assert.match(worker.profile.body, /公司自己的工具/);
  assert.deepEqual(endpointKey(worker), {
    name: "GLM_API_KEY",
    as: "CORP_API_KEY",
  });
  const opencode = await resolveWorker("opencode+glm-4.6", db);
  assert.deepEqual(endpointKey(opencode), {
    name: "GLM_API_KEY",
    as: "GLM_API_KEY",
  });
  // 只写密钥不写地址（地址配在工具自己的配置里）：照样按名注入同名变量。
  editProfile(
    db,
    "models/kimi-k3",
    { set: { endpoint_key: "KIMI_KEY" } },
    "u1",
  );
  assert.deepEqual(endpointKey(await resolveWorker("kimi+kimi-k3", db)), {
    name: "KIMI_KEY",
    as: "KIMI_KEY",
  });
  assert.equal(endpointKey(await resolveWorker("kimi", db)), undefined);
  const grok = await resolveWorker("grok+glm-4.6", db);
  assert.match(endpointFit(ADAPTERS.grok!, grok.profile.rules)!, /grok 不支持/);
  // 删掉协议：新名字又不是执行者了，改档案拒绝；库里被写坏的解析时撤下并说清楚。
  assert.throws(
    () => editProfile(db, "harness/corp-agent", { unset: ["protocol"] }, "u1"),
    /不是内置工具/,
  );
  writeProfile(db, {
    layer: "harness",
    name: "corp-agent",
    source: "---\nprotocol: cli\n---\n",
    author: "u1",
    reason: "写坏",
  });
  await assert.rejects(
    resolveWorker("corp-agent", db),
    /harness\/corp-agent 写得不对.*command/,
  );
  assert.equal(isTool("corp-agent"), false);
});

test("服务启动整批登记：坏的记日志跳过，其余照常；内置工具不受影响", () => {
  const db = profileDb();
  const put = (name: string, source: string) =>
    writeProfile(db, {
      layer: "harness",
      name,
      source,
      author: "u1",
      reason: "建",
    });
  put("good-a", "---\nprotocol: cli\ncommand: good-a\n---\n");
  put("broken", "---\nprotocol: cli\nargs: [x]\n---\n");
  put("codex", "---\ntrust: high\n---\n");
  const logs: string[] = [];
  loadCustomTools(db, (line) => logs.push(line));
  assert.equal(isTool("good-a"), true);
  assert.equal(isTool("broken"), false);
  assert.equal(ADAPTERS.codex!.tool, "codex");
  assert.deepEqual(logs.length, 1);
  assert.match(logs[0]!, /harness\/broken 没登记成执行者：command/);
});
