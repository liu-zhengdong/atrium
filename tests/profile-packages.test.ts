import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  injectBundledPackages,
  isBundledPackagePath,
  parseGitPackage,
  prepareProfile,
  syncIdentityNotes,
  syncIdentityPackages,
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

test("合集包路径识别：缺失的 pi-acp 也算，自定义 pi-acpx 不算", () => {
  const missingAcp = "/tmp/atrium-node_modules/@liuser/pi-acp";
  assert.equal(isBundledPackagePath(missingAcp), true);
  assert.equal(
    isBundledPackagePath(
      "/Users/me/.pi/agent/git/github.com/liu-zhengdong/pi-notes",
    ),
    true,
  );
  assert.equal(
    isBundledPackagePath("/Users/me/.pi/agent/extensions/pi-acpx"),
    false,
  );
  const root = mkdtempSync(join(tmpdir(), "atrium-bundled-name-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@liuser/pi-mcp-adapter" }),
    );
    assert.equal(isBundledPackagePath(root), true);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "other-ext" }),
    );
    assert.equal(isBundledPackagePath(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("injectBundledPackages 丢掉死路径，保留用户包", () => {
  const other = "/opt/exts/other-ext";
  const stale = "/Users/me/atrium/node_modules/@liuser/pi-acp";
  const next = injectBundledPackages([
    other,
    stale,
    { source: "/opt/git/pi-mcp-adapter", enabled: true },
  ]);
  assert.deepEqual(next, [other, bridge]);
});

test("syncIdentityPackages 覆盖已有 settings 里的死合集路径", () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-sync-pkg-"));
  const other = join(root, "other-ext");
  mkdirSync(other);
  writeFileSync(
    join(other, "package.json"),
    JSON.stringify({ name: "other-ext" }),
  );
  const settings = join(root, "settings.json");
  writeFileSync(
    settings,
    JSON.stringify({
      defaultModel: "fixture",
      packages: [join(root, "node_modules/@liuser/pi-acp"), other],
    }) + "\n",
  );
  try {
    syncIdentityPackages(root);
    const updated = JSON.parse(readFileSync(settings, "utf8")) as {
      packages: string[];
    };
    assert.deepEqual(updated.packages, [other, bridge]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A template whose notes live in a personal vault outside it, plus one identity. */
function vaultTemplate(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const template = join(root, "template"),
    vault = join(root, "vault"),
    identity = join(root, "identity");
  mkdirSync(template);
  mkdirSync(join(vault, "self-evolution"), { recursive: true });
  mkdirSync(join(identity, "notes"), { recursive: true });
  writeFileSync(
    join(template, "notes.json"),
    JSON.stringify({ directory: vault }),
  );
  writeFileSync(join(vault, "USER.md"), "模板里的用户理解");
  writeFileSync(join(vault, "self-evolution.md"), "协议正文");
  writeFileSync(join(vault, "self-evolution-Evolution.md"), "协议历史");
  writeFileSync(
    join(vault, "self-evolution", "user-understanding.md"),
    "子笔记",
  );
  writeFileSync(join(vault, "密钥管理.md"), "个人笔记");
  return { root, template, vault, identity, notes: join(identity, "notes") };
}

test("syncIdentityNotes 补齐旧身份缺的协议笔记，不覆盖它自己的副本", () => {
  const { root, template, identity, notes } =
    vaultTemplate("atrium-sync-notes-");
  writeFileSync(
    join(identity, "notes.json"),
    JSON.stringify({ directory: notes }),
  );
  writeFileSync(join(notes, "USER.md"), "身份自己改过的用户理解");
  try {
    syncIdentityNotes(identity, template);
    assert.equal(
      readFileSync(join(notes, "self-evolution.md"), "utf8"),
      "协议正文",
    );
    assert.equal(
      readFileSync(join(notes, "self-evolution-Evolution.md"), "utf8"),
      "协议历史",
    );
    assert.equal(
      readFileSync(
        join(notes, "self-evolution", "user-understanding.md"),
        "utf8",
      ),
      "子笔记",
    );
    assert.equal(
      readFileSync(join(notes, "USER.md"), "utf8"),
      "身份自己改过的用户理解",
    );
    assert(!existsSync(join(notes, "密钥管理.md")));
    // Idempotent: a second start must not resurrect or rewrite anything.
    writeFileSync(join(notes, "self-evolution.md"), "身份改过的协议");
    syncIdentityNotes(identity, template);
    assert.equal(
      readFileSync(join(notes, "self-evolution.md"), "utf8"),
      "身份改过的协议",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Every path under dir, so a write anywhere outside the target shows up. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    found.push(path);
    if (entry.isDirectory()) found.push(...walk(path));
  }
  return found.sort();
}

test("syncIdentityNotes 只写身份自己的 notes 目录", () => {
  const { root, template, vault, identity, notes } = vaultTemplate(
    "atrium-sync-notes-bad-",
  );
  writeFileSync(join(identity, "notes.json"), "{}");
  const before = walk(root);
  const rejected = [
    vault,
    "../vault",
    "~/Obsidian笔记",
    join(root, "elsewhere"),
    join(notes, "deeper"),
    42,
    null,
  ];
  try {
    for (const directory of rejected) {
      writeFileSync(
        join(identity, "notes.json"),
        JSON.stringify({ directory }),
      );
      syncIdentityNotes(identity, template);
      assert.deepEqual(walk(root), before, String(directory));
    }
    // No notes.json on either side is a no-op, not a crash.
    rmSync(join(identity, "notes.json"));
    syncIdentityNotes(identity, template);
    writeFileSync(
      join(identity, "notes.json"),
      JSON.stringify({ directory: notes }),
    );
    rmSync(join(template, "notes.json"));
    syncIdentityNotes(identity, template);
    assert.deepEqual(readdirSync(notes), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
