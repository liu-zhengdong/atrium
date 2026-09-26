import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  methodsFor,
  skipMethod,
  skipProvider,
  defaultAccountName,
  matchingProviders,
  assignmentFailure,
  assignmentSummary,
  accountLabel,
  currentAssignment,
} from "../shared/providers.ts";
import {
  ProviderDirectory,
  supplementEntry,
} from "../server/provider-directory.ts";
import { setSupplementModels } from "../server/account-models.ts";
import { Problem } from "../server/problem.ts";

const api = {
  id: "deepseek",
  name: "DeepSeek",
  methods: ["api_key" as const],
};
const oauth = {
  id: "openai-codex",
  name: "OpenAI Codex",
  methods: ["oauth" as const],
};
test("仅支持的方式可选；给定供应商跳过选择，单方式再跳过方式", () => {
  assert.deepEqual(methodsFor(api, "oauth"), []);
  assert.deepEqual(methodsFor(api, "api_key"), ["api_key"]);
  assert.equal(skipMethod(api), true);
  assert.equal(skipMethod({ ...api, methods: ["oauth", "api_key"] }), false);
  assert.equal(skipProvider(oauth), true);
  assert.equal(skipProvider(undefined), false);
});
test("默认账号名、搜索优先级和分配失败文案", () => {
  assert.equal(
    defaultAccountName(api, [{ name: "DeepSeek" }, { name: "DeepSeek 3" }]),
    "DeepSeek 2",
  );
  assert.deepEqual(
    matchingProviders(
      [
        { ...api, id: "azure-openai", name: "Azure OpenAI" },
        { ...api, id: "openai", name: "OpenAI" },
        { ...api, id: "openrouter", name: "OpenRouter" },
      ],
      "api_key",
      "open",
    ).map((entry) => entry.id),
    ["openai", "openrouter", "azure-openai"],
  );
  assert.equal(
    currentAssignment("a3", "deepseek", [
      { id: "k21", provider: "deepseek", assigned: ["a3"] },
    ]),
    "k21",
  );
  assert.equal(accountLabel(api, "DeepSeek 2", "k27"), "DeepSeek 2（k27）");
  assert.equal(accountLabel(api, "Iris", "k24"), "DeepSeek Iris（k24）");
  assert.equal(
    assignmentSummary(
      ["复测成功甲（a5）"],
      ["连接验收（a3）：k21 → k27"],
      ["复测成功乙（a6）：故障"],
    ),
    "新分配：复测成功甲（a5）\n替换：连接验收（a3）：k21 → k27\n失败：复测成功乙（a6）：故障",
  );
  assert.equal(
    assignmentFailure(
      { ref: "a3", name: "连接验收" },
      new Error("该身份已有此 provider 的账号，请先撤销"),
      api,
      [{ id: "k21", provider: "deepseek", assigned: ["a3"] }],
    ),
    "连接验收（a3）已在用 DeepSeek k21",
  );
});
test("供应商列表由 Atrium 维护，不看个人模板装了什么（#242）", () => {
  const template = mkdtempSync(join(tmpdir(), "atrium-provider-test-"));
  const previous = process.env.ATRIUM_PI_TEMPLATE;
  try {
    const list = () =>
      new ProviderDirectory()
        .list()
        .map(({ id, methods }) => ({ id, methods }));
    process.env.ATRIUM_PI_TEMPLATE = template;
    const empty = list();
    // 模板里装一个会注册供应商的插件，列表也不变。
    mkdirSync(join(template, "plugin"));
    writeFileSync(
      join(template, "settings.json"),
      JSON.stringify({ packages: ["./plugin"] }),
    );
    writeFileSync(
      join(template, "plugin", "package.json"),
      JSON.stringify({ pi: { extensions: ["index.mjs"] } }),
    );
    writeFileSync(
      join(template, "plugin", "index.mjs"),
      'export default (pi) => pi.registerProvider("xai-auth", {});',
    );
    assert.deepEqual(list(), empty);
    assert.deepEqual(
      [...empty].sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: "kimi-coding", methods: ["oauth", "api_key"] },
        { id: "openai-codex", methods: ["oauth"] },
        { id: "opencode-go", methods: ["api_key"] },
        { id: "xai", methods: ["oauth", "api_key"] },
      ],
    );
  } finally {
    if (previous === undefined) delete process.env.ATRIUM_PI_TEMPLATE;
    else process.env.ATRIUM_PI_TEMPLATE = previous;
    rmSync(template, { recursive: true, force: true });
  }
});
test("未知、旧 xai-auth 与不支持的方式各给可执行的修正", () => {
  const directory = new ProviderDirectory();
  const problem = (provider: string, method: "oauth" | "api_key") => {
    try {
      directory.require(provider, method);
    } catch (error) {
      assert.ok(error instanceof Problem);
      return error;
    }
    throw new Error("应当报错");
  };
  const unknown = problem("missing", "oauth");
  assert.match(unknown.message, /不存在：missing。可用：openai-codex、xai/);
  assert.equal(unknown.nextCommand, "atrium connect");
  const legacy = problem("xai-auth", "oauth");
  assert.match(legacy.message, /Pi 自带的 xai/);
  assert.equal(legacy.nextCommand, "atrium connect xai");
  assert.match(problem("antigravity", "oauth").message, /不再支持/);
  for (const method of ["oauth", "api_key"] as const)
    assert.match(
      problem("claude-bridge", method).message,
      /不再接入 Claude 模型.*#193/,
    );
  const method = problem("opencode-go", "oauth");
  assert.match(method.message, /不支持账号登录/);
  assert.equal(method.nextCommand, "atrium connect opencode-go");
  assert.equal(directory.require("openai-codex", "oauth").id, "openai-codex");
  assert.equal(directory.require("xai", "oauth").id, "xai");
});
test("补充模型只写身份没配置过的供应商，撤销只删 Atrium 写入的原样条目", () => {
  const identity = mkdtempSync(join(tmpdir(), "atrium-supplement-"));
  const file = join(identity, "models.json");
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  try {
    assert.deepEqual(
      supplementEntry("xai")?.models.map((model) => model.id),
      ["grok-4.7"],
    );
    assert.deepEqual(
      supplementEntry("openai-codex")?.models.map((model) => model.id),
      ["gpt-6-sol"],
    );
    assert.equal(supplementEntry("opencode-go"), null);
    writeFileSync(
      file,
      JSON.stringify({ providers: { cursor: { apiKey: "cursor-native" } } }),
    );
    setSupplementModels(identity, "xai", true);
    assert.deepEqual(read().providers.xai, supplementEntry("xai"));
    assert.equal(read().providers.cursor.apiKey, "cursor-native");
    setSupplementModels(identity, "xai", false);
    assert.equal(read().providers.xai, undefined);
    // 身份自己的配置不覆盖、不删除。
    const own = { baseUrl: "https://proxy.example/v1" };
    writeFileSync(file, JSON.stringify({ providers: { "openai-codex": own } }));
    setSupplementModels(identity, "openai-codex", true);
    assert.deepEqual(read().providers["openai-codex"], own);
    setSupplementModels(identity, "openai-codex", false);
    assert.deepEqual(read().providers["openai-codex"], own);
  } finally {
    rmSync(identity, { recursive: true, force: true });
  }
});
