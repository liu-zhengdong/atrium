import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeProviders,
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
import { ProviderDirectory } from "../server/provider-directory.ts";

const api = {
  id: "deepseek",
  name: "DeepSeek",
  methods: ["api_key" as const],
  packagePath: null,
};
const oauth = {
  id: "openai-codex",
  name: "OpenAI Codex",
  methods: ["oauth" as const],
  packagePath: null,
};
test("目录合并去重、双方式及插件路径保留", () => {
  assert.deepEqual(
    mergeProviders([api, { ...api, methods: ["oauth"] }, oauth]),
    [{ ...api, methods: ["api_key", "oauth"] }, oauth],
  );
  const plugin = mergeProviders([{ ...api, packagePath: "/plugin" }, api]);
  assert.equal(plugin[0]?.packagePath, "/plugin");
});
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
test("目录缓存复用；插件入口文件变化使其重新加载", async () => {
  const template = mkdtempSync(join(tmpdir(), "atrium-provider-test-"));
  const previous = process.env.ATRIUM_PI_TEMPLATE;
  process.env.ATRIUM_PI_TEMPLATE = template;
  const plugin = join(template, "plugin");
  const source = join(plugin, "src/index.ts");
  try {
    mkdirSync(join(plugin, "src"), { recursive: true });
    writeFileSync(
      join(template, "settings.json"),
      JSON.stringify({ packages: ["./plugin"] }),
    );
    writeFileSync(
      join(plugin, "package.json"),
      JSON.stringify({ pi: { extensions: ["src/index.ts"] } }),
    );
    writeFileSync(source, "export default 1");
    let calls = 0;
    const directory = new ProviderDirectory({
      list: async () => {
        calls++;
        return [api];
      },
    });
    await directory.list();
    await directory.list();
    assert.equal(calls, 1);
    const changed = new Date(Date.now() + 5000);
    utimesSync(source, changed, changed);
    await directory.list();
    assert.equal(calls, 2);
  } finally {
    if (previous === undefined) delete process.env.ATRIUM_PI_TEMPLATE;
    else process.env.ATRIUM_PI_TEMPLATE = previous;
    rmSync(template, { recursive: true, force: true });
  }
});
test("OAuth 目录拒绝不存在和仅 Key 的供应商", async () => {
  const directory = new ProviderDirectory({ list: async () => [api, oauth] });
  await assert.rejects(directory.require("deepseek", "oauth"), /不支持此方式/);
  await assert.rejects(directory.require("missing", "oauth"), /不存在/);
  assert.equal(
    (await directory.require("openai-codex", "oauth")).id,
    "openai-codex",
  );
});
