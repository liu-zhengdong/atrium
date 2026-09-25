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
import { exitCodes } from "../cli/contract.ts";
import {
  configureModel,
  liveThinkingProblem,
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

test("运行时清单是占位名也按模型 id 排序：离线与运行同一输入结果一致", () => {
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
    // 运行中清单：name 就是模型 id（占位名），与目录里的真名混着来。
    const cached = [
      { id: "ocgo-fake/deepseek-v4-flash", name: "deepseek-v4-flash" },
      { id: "ocgo-fake/minimax-m3", name: "minimax-m3" },
      { id: "ocgo-fake/qwen3.8-flash", name: "qwen3.8-flash" },
    ];
    const typo = {
      provider: "ocgo-fake",
      model: "deepseek-v4.1-flsh",
      thinking: null,
    } as const;
    const offline = caught(() => configureModel(store, agent.id, typo, []));
    const running = caught(() => configureModel(store, agent.id, typo, cached));
    assert.equal(offline.candidates?.[0]?.ref, "ocgo-fake/deepseek-v4.1-flash");
    assert.deepEqual(
      running.candidates,
      offline.candidates,
      "离线与运行的候选顺序要一致",
    );
  } finally {
    cleanup();
  }
});

test("issue 原例：清单里没有 v4.1 时，离线与运行都把 v4-flash 排第一", () => {
  const { store, agent, directory, cleanup } = withAgent("Tibo");
  try {
    writeFileSync(join(directory, "settings.json"), "{}\n");
    writeFileSync(
      join(directory, "models.json"),
      JSON.stringify({
        providers: {
          fake158: {
            baseUrl: "http://127.0.0.1:4534",
            models: [
              { id: "minimax-m3" },
              { id: "qwen3.8-flash" },
              { id: "deepseek-v4-flash" },
            ],
          },
        },
      }),
    );
    const cached = [
      { id: "fake158/deepseek-v4-flash", name: "deepseek-v4-flash" },
      { id: "fake158/minimax-m3", name: "minimax-m3" },
      { id: "fake158/qwen3.8-flash", name: "qwen3.8-flash" },
    ];
    const input = {
      provider: "fake158",
      model: "deepseek-v4.1-flash",
      thinking: null,
    } as const;
    const offline = caught(() => configureModel(store, agent.id, input, []));
    const running = caught(() =>
      configureModel(store, agent.id, input, cached),
    );
    assert.equal(offline.candidates?.[0]?.ref, "fake158/deepseek-v4-flash");
    assert.deepEqual(running.candidates, offline.candidates);
  } finally {
    cleanup();
  }
});

test("运行中被 pi 拒绝思考强度时，回中文档位和能直接执行的修正，退出码 3", () => {
  const agent = { name: "ocgo", ref: "a1" };
  const wanted = "ocgo-fake/deepseek-v4-flash";
  const problem = liveThinkingProblem(
    "RequestError: Invalid params: Thinking level not supported by the current model: max (supported: off)。模型配置已恢复原值。",
    wanted,
    agent,
  );
  assert.ok(problem);
  assert.equal(problem.code, "thinking_not_supported");
  assert.equal(exitCodes.thinking_not_supported, 3);
  assert.match(
    problem.message,
    /运行中的实例不支持思考强度 max，支持：off。模型配置已恢复原值。/,
  );
  assert.equal(
    problem.nextCommand,
    `atrium model ocgo ${wanted}:off`,
    "只支持 off 时修正给 :off（与离线同一条命令写法）",
  );
  // 多档时向强档优先：max 被拒、支持到 high 为止 → 修正 high。
  const mixed = liveThinkingProblem(
    "…Thinking level not supported by the current model: max (supported: off, low, high)…",
    wanted,
    agent,
  );
  assert.equal(mixed?.nextCommand, `atrium model ocgo ${wanted}:high`);
  assert.equal(
    liveThinkingProblem("运行中的实例没能当场切换：其它错误", wanted, agent),
    null,
    "不认识的报错不走兜底",
  );
});

test("models.json 定义了供应商时思考强度按 models.json 判断，不看缓存", () => {
  const { store, agent, directory, cleanup } = withAgent("ocgo");
  try {
    writeFileSync(join(directory, "settings.json"), "{}\n");
    // 缓存说支持 max，models.json 的条目没写 reasoning（pi 视角只支持 off）。
    writeFileSync(
      join(directory, "models-store.json"),
      JSON.stringify({
        "ocgo-fake": {
          models: [
            {
              id: "deepseek-v4-flash",
              name: "DeepSeek V4 Flash",
              reasoning: true,
              thinkingLevelMap: { low: "low", high: "high", max: "max" },
            },
          ],
        },
      }),
    );
    writeFileSync(
      join(directory, "models.json"),
      JSON.stringify({
        providers: {
          "ocgo-fake": {
            baseUrl: "http://127.0.0.1:4534",
            models: [{ id: "deepseek-v4-flash" }],
          },
        },
      }),
    );
    const error = caught(() =>
      configureModel(
        store,
        agent.id,
        { provider: "ocgo-fake", model: "deepseek-v4-flash", thinking: "max" },
        [{ id: "ocgo-fake/deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
      ),
    );
    assert.equal(error.code, "thinking_not_supported");
    assert.match(error.message, /支持：off/);
    assert.equal(
      error.nextCommand,
      "atrium model ocgo ocgo-fake/deepseek-v4-flash:off",
    );
  } finally {
    cleanup();
  }
});

test("provider 写错且只有一个可选时，回执带换 provider 就能执行的修正", () => {
  const { store, agent, directory, cleanup } = withAgent("梁文峰");
  try {
    writeFileSync(
      join(directory, "models-store.json"),
      JSON.stringify({
        "ocgo-fake": {
          models: [
            { id: "minimax-m3", name: "MiniMax M3" },
            { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
          ],
        },
      }),
    );
    const error = caught(() =>
      configureModel(
        store,
        agent.id,
        { provider: "nope", model: "deepseek", thinking: null },
        [],
      ),
    );
    assert.equal(error.code, "model_not_found");
    assert.match(error.message, /可用的 provider：ocgo-fake/);
    assert.match(
      error.nextCommand ?? "",
      /^atrium model 梁文峰 ocgo-fake\/deepseek/,
      `修正要换到唯一可选的 provider：${error.nextCommand}`,
    );
  } finally {
    cleanup();
  }
});
