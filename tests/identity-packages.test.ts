import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  ensureOwnPackages,
  changePackages,
  cloneTemplatePackages,
  ownSource,
  planPackages,
  prepareOwnPackages,
  saveAgentDefaults,
} from "../server/identity-packages.ts";
import { Problem, Store } from "../server/store.ts";
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

test("现有共享身份迁移到独立目录；重复启动不修改既有安装", () =>
  fixture((_root, template, identity) => {
    const from = join(template, "npm/node_modules/example"),
      to = join(identity, "npm/node_modules/example");
    mkdirSync(from, { recursive: true });
    writeFileSync(
      join(from, "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    );
    const resource = join(template, "dev-ext", "main.js");
    mkdirSync(join(template, "dev-ext"));
    writeFileSync(resource, "owned code");
    symlinkSync(resource, join(from, "entry.js"));
    symlinkSync(relative(from, resource), join(from, "entry-relative.js"));
    writeFileSync(
      join(identity, "settings.json"),
      JSON.stringify({ packages: [from] }),
    );
    const previous = process.env.ATRIUM_PI_TEMPLATE;
    process.env.ATRIUM_PI_TEMPLATE = template;
    try {
      assert.equal(ensureOwnPackages(identity), true);
      assert(existsSync(to));
      assert.equal(readFileSync(join(to, "entry.js"), "utf8"), "owned code");
      assert.equal(
        readFileSync(join(to, "entry-relative.js"), "utf8"),
        "owned code",
      );
      assert.equal(
        readlinkSync(join(to, "entry.js")).includes(template),
        false,
      );
      assert(
        (
          JSON.parse(readFileSync(join(identity, "settings.json"), "utf8")) as {
            packages: string[];
          }
        ).packages.includes("npm:example"),
      );
      assert.equal(ensureOwnPackages(identity), false);
      assert(existsSync(to), "restarting does not remove installations");
    } finally {
      if (previous === undefined) delete process.env.ATRIUM_PI_TEMPLATE;
      else process.env.ATRIUM_PI_TEMPLATE = previous;
    }
  }));

test("服务启动迁移共享插件，坏身份隔离；重复启动只迁移一次", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-plugins-boot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const template = join(root, "template"),
    data = join(root, "data");
  const previous = process.env.ATRIUM_PI_TEMPLATE;
  process.env.ATRIUM_PI_TEMPLATE = template;
  t.after(() => {
    if (previous === undefined) delete process.env.ATRIUM_PI_TEMPLATE;
    else process.env.ATRIUM_PI_TEMPLATE = previous;
  });
  mkdirSync(join(template, "dev-ext"), { recursive: true });
  mkdirSync(data);
  writeFileSync(join(template, "dev-ext", "main.js"), "private copy");
  const store = new Store(join(data, "atrium.sqlite"));
  const good = join(root, "good"),
    broken = join(root, "broken");
  for (const [name, dir, spec] of [
    ["Good", good, join(template, "dev-ext")],
    ["Broken", broken, "npm:missing"],
  ]) {
    mkdirSync(dir);
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        packages: [spec],
        skills: [join(template, "dev-ext", "main.js")],
      }),
    );
    const agent = store.createAgent(name, root).agent;
    store.run("UPDATE agents SET agent_directory=? WHERE id=?", dir, agent.id);
  }
  store.close();
  const errors: string[] = [],
    logs: string[] = [];
  const originalError = console.error;
  t.mock.method(console, "error", (...args: unknown[]) => {
    if (String(args[0]).includes("插件迁移失败")) errors.push(String(args[0]));
    else originalError(...args);
  });
  t.mock.method(console, "log", (text: string) => {
    if (text.includes("个人 Pi 插件已转为")) logs.push(text);
  });
  for (const pass of [1, 2]) {
    const { app } = await createApp({
      data,
      piHome: join(root, "pi"),
      desktops: join(root, "desktops"),
    });
    try {
      await app.ready();
    } finally {
      await app.close();
    }
    if (pass === 1) {
      assert.equal(logs.length, 1);
      assert.equal(errors.length, 1);
      assert(existsSync(join(good, ".atrium-packages.json")));
      assert.equal(existsSync(join(broken, ".atrium-packages.json")), false);
      assert.equal(
        readFileSync(
          join(good, "local", readdirSync(join(good, "local"))[0], "main.js"),
          "utf8",
        ),
        "private copy",
      );
      assert.equal(
        readFileSync(join(good, "settings.json"), "utf8").includes(template),
        false,
      );
      assert.equal(
        readFileSync(join(broken, "settings.json"), "utf8").includes(
          "npm:missing",
        ),
        true,
      );
    } else assert.equal(logs.length, 1, "already migrated stays untouched");
  }
});

test("暂存失败回滚：原插件和配置不变，不留下暂存目录", () =>
  fixture((_root, template, identity) => {
    const install = join(identity, "npm/node_modules/keep");
    mkdirSync(install, { recursive: true });
    writeFileSync(join(install, "package.json"), '{"version":"1.0.0"}');
    writeFileSync(
      join(identity, "settings.json"),
      JSON.stringify({ packages: ["npm:missing"] }),
    );
    const previous = process.env.ATRIUM_PI_TEMPLATE;
    process.env.ATRIUM_PI_TEMPLATE = template;
    try {
      invalid(() => ensureOwnPackages(identity), 400);
      assert.equal(
        readFileSync(join(install, "package.json"), "utf8"),
        '{"version":"1.0.0"}',
      );
      assert.equal(
        readFileSync(join(identity, "settings.json"), "utf8"),
        '{"packages":["npm:missing"]}',
      );
      assert.equal(
        readdirSync(identity).some((name) => name.startsWith(".packages-")),
        false,
      );
    } finally {
      if (previous === undefined) delete process.env.ATRIUM_PI_TEMPLATE;
      else process.env.ATRIUM_PI_TEMPLATE = previous;
    }
  }));

test("模板内本地路径包复制到身份，外部包路径不改；缺失默认插件拒绝", () =>
  fixture((_root, template, identity) => {
    const local = join(template, "dev-ext");
    mkdirSync(local);
    assert.equal(ownSource(local, template), local);
    const [copy] = cloneTemplatePackages(template, identity, [local]);
    assert.equal(typeof copy, "string");
    assert((copy as string).startsWith(join(identity, "local")));
    assert(existsSync(copy as string));
    const outside = join(_root, "external-ext");
    mkdirSync(outside);
    assert.deepEqual(cloneTemplatePackages(template, identity, [outside]), [
      outside,
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
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `${path}/mode`,
        payload: { mode: "shared" },
      })
    ).statusCode,
    410,
  );
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
