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
