import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createApp } from "../server/app.ts";
import { Problem } from "../server/store.ts";
import { Runtimes } from "../server/runtime.ts";
import {
  parseGitPackage,
  prepareProfile,
  templatePackagePath,
} from "../server/profile.ts";

const require = createRequire(import.meta.url);
const bridge = dirname(require.resolve("@liuser/pi-atrium/package.json"));

test("parseGitPackage 覆盖 Pi 与 npm 常见写法", () => {
  assert.deepEqual(
    parseGitPackage("git:github.com/liu-zhengdong/pi-mcp-adapter"),
    {
      host: "github.com",
      path: "liu-zhengdong/pi-mcp-adapter",
    },
  );
  assert.deepEqual(
    parseGitPackage("git:github.com/liu-zhengdong/pi-mcp-adapter@v2.34.1"),
    { host: "github.com", path: "liu-zhengdong/pi-mcp-adapter" },
  );
  assert.deepEqual(parseGitPackage("github:liu-zhengdong/pi-mcp-adapter"), {
    host: "github.com",
    path: "liu-zhengdong/pi-mcp-adapter",
  });
  assert.deepEqual(
    parseGitPackage("https://github.com/liu-zhengdong/pi-mcp-adapter.git"),
    { host: "github.com", path: "liu-zhengdong/pi-mcp-adapter" },
  );
  assert.deepEqual(
    parseGitPackage("git:git@github.com:liu-zhengdong/pi-mcp-adapter"),
    { host: "github.com", path: "liu-zhengdong/pi-mcp-adapter" },
  );
  assert.equal(parseGitPackage("npm:@liuser/pi-mcp-adapter"), null);
});

test("templatePackagePath 指向 Pi 的 npm/git 安装布局", () => {
  const root = "/tmp/pi-template";
  assert.equal(
    templatePackagePath(root, "npm:@liuser/pi-mcp-adapter"),
    join(root, "npm/node_modules/@liuser/pi-mcp-adapter"),
  );
  assert.equal(
    templatePackagePath(root, "git:github.com/liu-zhengdong/pi-mcp-adapter"),
    join(root, "git/github.com/liu-zhengdong/pi-mcp-adapter"),
  );
  assert.equal(
    templatePackagePath(root, "github:liu-zhengdong/pi-notes"),
    join(root, "git/github.com/liu-zhengdong/pi-notes"),
  );
  assert.throws(
    () => templatePackagePath(root, "git:not-a-repo"),
    (error: unknown) => error instanceof Problem && error.statusCode === 400,
  );
});

test("创建身份解析已安装的 git 包，并注入本应用的 pi-atrium", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-profile-pkg-"));
  const template = join(root, "template");
  const other = join(template, "git/github.com/example/other-ext");
  const adapter = join(template, "git/github.com/liu-zhengdong/pi-mcp-adapter");
  const notes = join(template, "git/github.com/liu-zhengdong/pi-notes");
  const foreignAcp = join(template, "git/github.com/liu-zhengdong/pi-acp");
  for (const dir of [other, adapter, notes, foreignAcp])
    mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(other, "package.json"),
    JSON.stringify({ name: "other-ext" }),
  );
  writeFileSync(
    join(adapter, "package.json"),
    JSON.stringify({ name: "@liuser/pi-mcp-adapter" }),
  );
  writeFileSync(
    join(notes, "package.json"),
    JSON.stringify({ name: "@liuser/pi-notes" }),
  );
  writeFileSync(
    join(foreignAcp, "package.json"),
    JSON.stringify({ name: "@liuser/pi-acp" }),
  );
  writeFileSync(
    join(template, "settings.json"),
    JSON.stringify({
      defaultModel: "fixture",
      packages: [
        "git:github.com/example/other-ext",
        "git:github.com/liu-zhengdong/pi-mcp-adapter",
        "git:github.com/liu-zhengdong/pi-notes",
        "git:github.com/liu-zhengdong/pi-acp",
      ],
    }),
  );
  t.mock.method(
    Runtimes.prototype as unknown as { rpc: () => Promise<unknown> },
    "rpc",
    async () => ({ runtimes: [] }),
  );
  t.mock.method(Runtimes.prototype, "pump", async () => {});
  const { app } = await createApp({
    data: join(root, "data"),
    desktops: join(root, "desktops"),
    piHome: join(root, ".pi"),
  });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const created = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { name: "GitPack", template },
  });
  assert.equal(created.statusCode, 201, created.body);
  const settings = JSON.parse(
    readFileSync(
      join(created.json().agent.agent_directory, "settings.json"),
      "utf8",
    ),
  ) as { packages: string[] };
  assert.deepEqual(
    settings.packages.filter((p) => p.includes("other-ext")),
    [realpathSync(other)],
  );
  assert.equal(
    settings.packages.some((p) => p.includes("pi-mcp-adapter")),
    false,
  );
  assert.equal(
    settings.packages.some((p) => p.includes("pi-notes")),
    false,
  );
  assert.equal(settings.packages.includes(foreignAcp), false);
  assert.equal(settings.packages.includes(bridge), true);
});

test("未安装的 git 包拒绝创建", () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-profile-missing-"));
  const template = join(root, "template");
  mkdirSync(template);
  writeFileSync(
    join(template, "settings.json"),
    JSON.stringify({
      packages: ["git:github.com/liu-zhengdong/missing-pkg"],
    }),
  );
  try {
    assert.throws(
      () => prepareProfile("id1", template, join(root, ".pi")),
      (error: unknown) =>
        error instanceof Problem &&
        error.statusCode === 400 &&
        String(error.message).includes("未安装"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
