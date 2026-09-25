import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Problem } from "../server/problem.ts";
import { Store } from "../server/store.ts";
import {
  configureModel,
  offlineModels,
  rememberModels,
  seedModelsStore,
} from "../server/model.ts";

const withAgent = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-158-"));
  const store = new Store(":memory:");
  const agent = store.createAgent(name, dir).agent;
  const directory = join(dir, "identity");
  mkdirSync(directory);
  store.run(
    "UPDATE agents SET agent_directory=? WHERE id=?",
    directory,
    agent.id,
  );
  return {
    store,
    agent,
    directory,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const caught = (fn: () => unknown): Problem => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Problem, `期望 Problem，实际 ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: "期望抛错但没有" });
};

test("候选按相似度排序：deepseek-v4.1-flash 排第一的是 deepseek-v4-flash", () => {
  const { store, agent, cleanup } = withAgent("梁文峰");
  try {
    // 三个候选按「会先撞上错误答案」的顺序摆，照旧截前三会选到 minimax-m3。
    const options = [
      { id: "opencode-go/minimax-m3", name: "MiniMax M3" },
      { id: "opencode-go/qwen3.8-flash", name: "Qwen3.8 Flash" },
      { id: "opencode-go/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    ];
    const error = caught(() =>
      configureModel(
        store,
        agent.id,
        {
          provider: "opencode-go",
          model: "deepseek-v4.1-flash",
          thinking: null,
        },
        options,
      ),
    );
    assert.equal(error.code, "model_not_found");
    assert.equal(
      error.candidates?.[0]?.ref,
      "opencode-go/deepseek-v4-flash",
      `候选排序不对：${JSON.stringify(error.candidates)}`,
    );
  } finally {
    cleanup();
  }
});

test("没启动过的身份按目录里的缓存校验：缓存有的能设，写错给相似候选", () => {
  const { store, agent, directory, cleanup } = withAgent("ocgo");
  try {
    writeFileSync(join(directory, "settings.json"), "{}\n");
    writeFileSync(
      join(directory, "models-store.json"),
      JSON.stringify({
        "ocgo-fake": {
          models: [
            { id: "minimax-m3", name: "MiniMax M3" },
            { id: "qwen3.8-flash", name: "Qwen3.8 Flash" },
            { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
            { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
          ],
        },
      }),
    );
    // options 为空 = 身份没启动过，只靠目录里的缓存。
    const ok = configureModel(
      store,
      agent.id,
      { provider: "ocgo-fake", model: "deepseek-v4.1-flash", thinking: null },
      [],
    );
    assert.equal(ok.configured, "ocgo-fake/deepseek-v4.1-flash");
    const error = caught(() =>
      configureModel(
        store,
        agent.id,
        { provider: "ocgo-fake", model: "deepseek-v4", thinking: null },
        [],
      ),
    );
    assert.equal(error.code, "model_not_found");
    assert.equal(error.candidates?.[0]?.ref, "ocgo-fake/deepseek-v4-flash");
  } finally {
    cleanup();
  }
});

test("思考强度不支持时回支持的档位，并给能直接执行的修正命令", () => {
  const { store, agent, directory, cleanup } = withAgent("梁文峰");
  try {
    writeFileSync(join(directory, "settings.json"), "{}\n");
    writeFileSync(
      join(directory, "models-store.json"),
      JSON.stringify({
        "ocgo-fake": {
          models: [
            {
              id: "deepseek-v4-flash",
              name: "DeepSeek V4 Flash",
              reasoning: true,
              thinkingLevelMap: {
                off: null,
                minimal: null,
                low: "low",
                medium: null,
                high: "high",
                xhigh: null,
                max: "max",
              },
            },
          ],
        },
      }),
    );
    const options = [
      { id: "ocgo-fake/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    ];
    const spec = {
      provider: "ocgo-fake",
      model: "deepseek-v4-flash",
      thinking: "xhigh",
    } as const;
    const error = caught(() => configureModel(store, agent.id, spec, options));
    assert.equal(error.code, "thinking_not_supported");
    assert.match(error.message, /不支持思考强度 xhigh，支持：low、high、max/);
    assert.equal(
      error.nextCommand,
      "atrium model 梁文峰 ocgo-fake/deepseek-v4-flash:max",
    );
    // 修正命令照抄执行：max 档通过并写进身份配置。
    const ok = configureModel(
      store,
      agent.id,
      { ...spec, thinking: "max" },
      options,
    );
    assert.equal(ok.configured, "ocgo-fake/deepseek-v4-flash:max");
    const settings = JSON.parse(
      readFileSync(join(directory, "settings.json"), "utf8"),
    );
    assert.equal(settings.defaultThinkingLevel, "max");
  } finally {
    cleanup();
  }
});

test("分配时从模板带上供应商的模型目录缓存，不覆盖、坏文件挪开", () => {
  const template = mkdtempSync(join(tmpdir(), "atrium-158-template-"));
  const identity = mkdtempSync(join(tmpdir(), "atrium-158-identity-"));
  const file = join(identity, "models-store.json");
  try {
    writeFileSync(
      join(template, "models-store.json"),
      JSON.stringify({
        "ocgo-fake": { models: [{ id: "deepseek-v4.1-flash" }] },
      }),
    );
    // 模板里没有的供应商：跳过，不建文件。
    assert.equal(seedModelsStore(identity, "fake158", template), false);
    assert.equal(existsSync(file), false);
    // 模板里有：写进身份目录。
    assert.equal(seedModelsStore(identity, "ocgo-fake", template), true);
    assert.ok(
      JSON.parse(readFileSync(file, "utf8"))["ocgo-fake"]?.models?.length,
    );
    // 身份自己已经有的：不覆盖。
    writeFileSync(
      file,
      JSON.stringify({ "ocgo-fake": { models: [{ id: "local-model" }] } }),
    );
    assert.equal(seedModelsStore(identity, "ocgo-fake", template), false);
    assert.equal(
      JSON.parse(readFileSync(file, "utf8"))["ocgo-fake"].models[0].id,
      "local-model",
    );
    // 文件坏了：原文挪开留档，再带上模板的缓存。
    writeFileSync(file, "{broken");
    assert.equal(seedModelsStore(identity, "ocgo-fake", template), true);
    assert.equal(readFileSync(`${file}.unreadable`, "utf8"), "{broken");
    assert.ok(JSON.parse(readFileSync(file, "utf8"))["ocgo-fake"]);
  } finally {
    rmSync(template, { recursive: true, force: true });
    rmSync(identity, { recursive: true, force: true });
  }
});

test("离线清单合并运行缓存与身份目录，占位名升级成真名", () => {
  const { store, agent, directory, cleanup } = withAgent("ocgo");
  try {
    writeFileSync(
      join(directory, "models-store.json"),
      JSON.stringify({
        "ocgo-fake": {
          models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
        },
      }),
    );
    writeFileSync(
      join(directory, "models.json"),
      JSON.stringify({
        providers: {
          fake158: {
            baseUrl: "http://127.0.0.1:4534",
            models: [{ id: "deepseek-v4.1-flash" }],
          },
        },
      }),
    );
    rememberModels(store, agent.id, [
      {
        id: "ocgo-fake/deepseek-v4-flash",
        name: "ocgo-fake/deepseek-v4-flash",
      },
    ]);
    const merged = offlineModels(store, agent.id);
    const stored = merged.find(
      (item) => item.id === "ocgo-fake/deepseek-v4-flash",
    );
    assert.equal(stored?.name, "DeepSeek V4 Flash");
    assert.ok(merged.some((item) => item.id === "fake158/deepseek-v4.1-flash"));
  } finally {
    cleanup();
  }
});
