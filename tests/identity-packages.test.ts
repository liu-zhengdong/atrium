import { test } from "node:test";
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
import {
  changeMode,
  changePackages,
  cloneTemplatePackages,
  ownSource,
  planPackages,
  prepareOwnPackages,
  saveAgentDefaults,
} from "../server/identity-packages.ts";
import { Problem } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { Runtimes } from "../server/runtime.ts";

const fixture = (
  run: (root: string, template: string, identity: string) => void,
) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-plugins-"));
  const template = join(root, "template"),
    identity = join(root, "identity");
  mkdirSync(template);
  mkdirSync(identity);
  try {
    run(root, template, identity);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const invalid = (fn: () => unknown, status: number) =>
  assert.throws(
    fn,
    (error: unknown) => error instanceof Problem && error.statusCode === status,
  );

test("插件计划穷举动作：合法变更、重复、缺失、内置与破坏 spec", () => {
  const current = [
    "npm:example",
    { source: "git:github.com/example/other", extensions: [] },
    "/tmp/local",
    "npm:@liuser/pi-atrium",
  ];
  assert.deepEqual(planPackages(current, { action: "add", spec: "npm:next" }), [
    ...current,
    "npm:next",
  ]);
  assert.deepEqual(
    planPackages(current, { action: "remove", spec: "npm:example" }),
    current.slice(1),
  );
  assert.deepEqual(
    planPackages(current, { action: "disable", spec: "npm:example" })[0],
    {
      source: "npm:example",
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    },
  );
  assert.equal(
    planPackages(current, {
      action: "enable",
      spec: "git:github.com/example/other",
    })[1],
    "git:github.com/example/other",
  );
  assert.deepEqual(
    planPackages(current, { action: "update", spec: "npm:example" }),
    current,
  );
  assert.deepEqual(planPackages(current, { action: "update-all" }), current);
  assert.deepEqual(
    planPackages(["/path/removed"], {
      action: "remove",
      spec: "/path/removed",
    }),
    [],
  );
  invalid(
    () => planPackages(current, { action: "update", spec: "/tmp/local" }),
    400,
  );
  for (const action of [
    "add",
    "remove",
    "update",
    "enable",
    "disable",
  ] as const) {
    invalid(
      () => planPackages(current, { action, spec: "npm:@liuser/pi-atrium" }),
      400,
    );
    invalid(() => planPackages(current, { action, spec: "npm:bad name" }), 400);
    invalid(
      () => planPackages(current, { action, spec: "git:not-a-repo" }),
      400,
    );
  }
  invalid(
    () => planPackages(current, { action: "add", spec: "npm:example" }),
    409,
  );
  invalid(
    () => planPackages(current, { action: "update", spec: "npm:missing" }),
    404,
  );
});

test("现有共享身份复制包到独立目录，切回共享保留原引用；缺少包不修改 settings", () =>
  fixture((_root, template, identity) => {
    const from = join(template, "npm/node_modules/example"),
      to = join(identity, "npm/node_modules/example");
    mkdirSync(from, { recursive: true });
    writeFileSync(
      join(from, "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    );
    writeFileSync(
      join(identity, "settings.json"),
      JSON.stringify({ packages: [from] }),
    );
    const previous = process.env.ATRIUM_PI_TEMPLATE;
    process.env.ATRIUM_PI_TEMPLATE = template;
    try {
      assert.equal(changeMode(identity, "own").mode, "own");
      assert(existsSync(to));
      assert(
        (
          JSON.parse(readFileSync(join(identity, "settings.json"), "utf8")) as {
            packages: string[];
          }
        ).packages.includes("npm:example"),
      );
      assert.equal(changeMode(identity, "shared").mode, "shared");
      assert(
        (
          JSON.parse(readFileSync(join(identity, "settings.json"), "utf8")) as {
            packages: string[];
          }
        ).packages.includes(from),
      );
      assert(existsSync(to), "switch back does not delete installations");
      writeFileSync(
        join(identity, "settings.json"),
        JSON.stringify({
          packages: [join(template, "npm/node_modules/missing")],
        }),
      );
      const before = readFileSync(join(identity, "settings.json"), "utf8");
      invalid(() => changeMode(identity, "own"), 400);
      assert.equal(
        readFileSync(join(identity, "settings.json"), "utf8"),
        before,
      );
    } finally {
      if (previous === undefined) delete process.env.ATRIUM_PI_TEMPLATE;
      else process.env.ATRIUM_PI_TEMPLATE = previous;
    }
  }));

test("插件配置不复制本地路径包；缺失默认插件拒绝，失败不留半成品", () =>
  fixture((_root, template, identity) => {
    const local = join(template, "dev-ext");
    mkdirSync(local);
    assert.equal(ownSource(local, template), local);
    assert.deepEqual(cloneTemplatePackages(template, identity, [local]), [
      local,
    ]);
    writeFileSync(
      join(template, "settings.json"),
      JSON.stringify({ packages: ["npm:missing"] }),
    );
    invalid(() => prepareOwnPackages(template, identity, ["npm:missing"]), 400);
    assert.equal(existsSync(join(identity, "npm")), false);
  }));

test("HTTP 默认配置与身份插件 API 只改目标身份；无效和内置包拒绝", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-plugin-api-"));
  const template = join(root, "template");
  mkdirSync(template);
  writeFileSync(
    join(template, "settings.json"),
    JSON.stringify({ packages: [] }),
  );
  const previous = process.env.ATRIUM_PI_TEMPLATE;
  process.env.ATRIUM_PI_TEMPLATE = template;
  t.mock.method(
    Runtimes.prototype as unknown as { rpc: () => Promise<unknown> },
    "rpc",
    async () => ({ runtimes: [] }),
  );
  t.mock.method(Runtimes.prototype, "pump", async () => {});
  const { app } = await createApp({
    data: join(root, "data"),
    desktops: join(root, "desktops"),
    piHome: join(root, "pi"),
  });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ATRIUM_PI_TEMPLATE;
    else process.env.ATRIUM_PI_TEMPLATE = previous;
  });
  const defaults = {
    packages: [],
    skills: [],
    model: { provider: "deepseek", model: "deepseek-flash" },
  };
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/api/settings/agent-defaults",
        payload: defaults,
      })
    ).statusCode,
    200,
  );
  assert.deepEqual(
    (await app.inject({ url: "/api/settings/agent-defaults" })).json(),
    defaults,
  );
  const created = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { name: "Test" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const directory = created.json().agent.agent_directory as string;
  assert.equal(
    (
      JSON.parse(readFileSync(join(directory, "settings.json"), "utf8")) as {
        defaultModel: string;
      }
    ).defaultModel,
    "deepseek-flash",
  );
  const path = `/api/agents/${created.json().agent.id}/plugins`;
  assert.equal((await app.inject({ url: path })).json().mode, "own");
  for (const spec of [
    "npm:@liuser/pi-atrium",
    "npm:bad spec",
    "git:not-a-repo",
  ]) {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          payload: { action: "add", spec },
        })
      ).statusCode,
      400,
    );
  }
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: path,
        payload: { action: "remove", spec: "npm:@liuser/pi-atrium" },
      })
    ).statusCode,
    400,
  );
  assert.equal((await app.inject({ url: path })).json().packages.length, 1);
});

test("默认配置不允许任意技能路径或内置插件", () =>
  fixture((root) => {
    invalid(
      () =>
        saveAgentDefaults(root, {
          packages: ["npm:@liuser/pi-atrium"],
          skills: [],
          model: null,
        }),
      400,
    );
    invalid(
      () =>
        saveAgentDefaults(root, {
          packages: [],
          skills: ["../secret"],
          model: null,
        }),
      400,
    );
    assert.equal(existsSync(join(root, "agent-defaults.json")), false);
  }));
