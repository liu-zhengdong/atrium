import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createApp } from "../server/app.ts";
import { Problem } from "../server/store.ts";
import { Runtimes } from "../server/runtime.ts";
import {
  adoptIdentityConfig,
  injectBundledPackages,
  isBundledPackagePath,
  prepareProfile,
  syncIdentityNotes,
  syncIdentityPackages,
  syncIdentityProfile,
} from "../server/profile.ts";
import {
  parseGitPackage,
  templatePackagePath,
} from "../server/package-spec.ts";

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
    auth: false,
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
    ["git:github.com/example/other-ext"],
  );
  assert(
    existsSync(
      join(
        created.json().agent.agent_directory,
        "git/github.com/example/other-ext",
      ),
    ),
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
    // Without its notes.json the identity's notes are <identity>/notes, so the
    // bundled note lands there; without either notes.json nothing comes from
    // the vault. Neither case crashes.
    rmSync(join(identity, "notes.json"));
    syncIdentityNotes(identity, template);
    assert.deepEqual(readdirSync(notes), ["职责.md"]);
    writeFileSync(
      join(identity, "notes.json"),
      JSON.stringify({ directory: notes }),
    );
    rmSync(join(template, "notes.json"));
    syncIdentityNotes(identity, template);
    assert.deepEqual(readdirSync(notes), ["职责.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const LINKED_FILES = ["AGENTS.md", "SYSTEM.md", "mcp.json", "models.json"];

/** An identity laid out the old way: rules linked into shared config, notes in the user's vault. */
function legacyProfile(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const shared = join(root, "shared"),
    vault = join(root, "vault"),
    identity = join(root, "identity");
  mkdirSync(shared);
  mkdirSync(join(vault, "self-evolution"), { recursive: true });
  mkdirSync(identity);
  for (const name of LINKED_FILES) {
    writeFileSync(join(shared, name), `用户全局的 ${name}`);
    symlinkSync(join(shared, name), join(identity, name));
  }
  writeFileSync(join(vault, "USER.md"), "对用户的理解");
  writeFileSync(join(vault, "self-evolution.md"), "协议正文");
  writeFileSync(join(vault, "self-evolution", "note.md"), "子笔记");
  writeFileSync(join(vault, "密钥管理.md"), "个人笔记");
  writeFileSync(
    join(identity, "notes.json"),
    JSON.stringify({ directory: vault, maxContextBytes: 262144 }),
  );
  return { root, shared, vault, identity };
}

test("旧身份的共享规则和笔记转成自有副本", () => {
  const { root, shared, vault, identity } = legacyProfile("atrium-adopt-");
  const notes = join(identity, "notes");
  try {
    adoptIdentityConfig(identity);
    for (const name of LINKED_FILES) {
      assert(!lstatSync(join(identity, name)).isSymbolicLink(), name);
      assert.equal(
        readFileSync(join(identity, name), "utf8"),
        `用户全局的 ${name}`,
      );
    }
    // Self-evolution now rewrites the identity's own rule, not the user's file.
    writeFileSync(join(identity, "AGENTS.md"), "身份自己的规则");
    assert.equal(
      readFileSync(join(shared, "AGENTS.md"), "utf8"),
      "用户全局的 AGENTS.md",
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(identity, "notes.json"), "utf8")),
      { directory: notes, maxContextBytes: 262144 },
    );
    assert.equal(readFileSync(join(notes, "USER.md"), "utf8"), "对用户的理解");
    assert.equal(
      readFileSync(join(notes, "self-evolution", "note.md"), "utf8"),
      "子笔记",
    );
    assert(!existsSync(join(notes, "密钥管理.md")));
    // The vault is only ever read.
    assert.deepEqual(readdirSync(vault).sort(), [
      "USER.md",
      "self-evolution",
      "self-evolution.md",
      "密钥管理.md",
    ]);
    // Idempotent: a second start keeps what the identity has since written.
    writeFileSync(join(notes, "USER.md"), "身份改过的理解");
    adoptIdentityConfig(identity);
    assert.equal(
      readFileSync(join(notes, "USER.md"), "utf8"),
      "身份改过的理解",
    );
    assert.equal(
      readFileSync(join(identity, "AGENTS.md"), "utf8"),
      "身份自己的规则",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("notes 目录是符号链接时拒绝迁移，不写进用户笔记库", () => {
  const { root, vault, identity } = legacyProfile("atrium-adopt-linked-");
  symlinkSync(vault, join(identity, "notes"));
  const before = walk(vault);
  try {
    assert.throws(
      () => adoptIdentityConfig(identity),
      (error: unknown) =>
        error instanceof Problem &&
        String(error.message).includes("notes 目录是符号链接"),
    );
    assert.deepEqual(walk(vault), before);
    assert.equal(
      JSON.parse(readFileSync(join(identity, "notes.json"), "utf8")).directory,
      vault,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("断链的规则文件报错并保留原状，其余照常转换", () => {
  const { root, shared, identity } = legacyProfile("atrium-adopt-dead-");
  rmSync(join(shared, "SYSTEM.md"));
  try {
    assert.throws(
      () => adoptIdentityConfig(identity),
      (error: unknown) =>
        error instanceof Problem &&
        error.statusCode === 500 &&
        String(error.message).includes("SYSTEM.md"),
    );
    assert(lstatSync(join(identity, "SYSTEM.md")).isSymbolicLink());
    assert(!existsSync(join(identity, "SYSTEM.md.adopting")));
    assert(!lstatSync(join(identity, "AGENTS.md")).isSymbolicLink());
    assert.equal(
      JSON.parse(readFileSync(join(identity, "notes.json"), "utf8")).directory,
      join(identity, "notes"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("规则和笔记同时卡住时，两边都报出来", () => {
  const { root, shared, vault, identity } = legacyProfile("atrium-adopt-both-");
  rmSync(join(shared, "SYSTEM.md"));
  symlinkSync(vault, join(identity, "notes"));
  try {
    assert.throws(
      () => adoptIdentityConfig(identity),
      (error: unknown) =>
        error instanceof Problem &&
        String(error.message).includes("SYSTEM.md") &&
        String(error.message).includes("notes 目录是符号链接"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncIdentityProfile 报告未能补齐的部分，仍让身份启动", () => {
  const { root, shared, identity } = legacyProfile("atrium-sync-profile-");
  rmSync(join(shared, "SYSTEM.md"));
  try {
    const notices = syncIdentityProfile(identity);
    assert.equal(notices.length, 1);
    assert(notices[0]!.startsWith("配置未能转成自有副本："));
    assert(notices[0]!.includes("SYSTEM.md"));
    assert(!lstatSync(join(identity, "AGENTS.md")).isSymbolicLink());
    assert.deepEqual(syncIdentityProfile(identity).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("旧布局身份先搬笔记再补齐：模板才有的协议笔记也能拿到", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atrium-notes-order-")));
  const template = join(root, "template"),
    templateVault = join(root, "template-vault"),
    ownVault = join(root, "own-vault"),
    identity = join(root, "identity");
  mkdirSync(template, { recursive: true });
  mkdirSync(templateVault, { recursive: true });
  mkdirSync(ownVault, { recursive: true });
  mkdirSync(identity, { recursive: true });
  // The template's vault has both protocol notes; the identity's older vault
  // predates self-evolution.md — only the top-up step can supply it.
  writeFileSync(join(templateVault, "USER.md"), "模板的用户理解");
  writeFileSync(join(templateVault, "self-evolution.md"), "模板的协议正文");
  writeFileSync(join(ownVault, "USER.md"), "身份自己的用户理解");
  writeFileSync(
    join(template, "notes.json"),
    JSON.stringify({ directory: templateVault }),
  );
  writeFileSync(
    join(identity, "notes.json"),
    JSON.stringify({ directory: ownVault }),
  );
  try {
    adoptIdentityConfig(identity, template);
    const notes = join(identity, "notes");
    // Moved in from its own vault, then topped up from the template's.
    assert.equal(
      readFileSync(join(notes, "USER.md"), "utf8"),
      "身份自己的用户理解",
    );
    assert.equal(
      readFileSync(join(notes, "self-evolution.md"), "utf8"),
      "模板的协议正文",
    );
    // Neither vault is written.
    assert.deepEqual(readdirSync(ownVault), ["USER.md"]);
    assert.deepEqual(readdirSync(templateVault).sort(), [
      "USER.md",
      "self-evolution.md",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A template holding the user's own skills, extensions and themes. */
function resourceTemplate(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const template = join(root, "template");
  mkdirSync(join(template, "skills", "写作"), { recursive: true });
  mkdirSync(join(template, "extensions"), { recursive: true });
  mkdirSync(join(template, "themes"), { recursive: true });
  writeFileSync(join(template, "skills", "写作", "SKILL.md"), "用户的写作技能");
  writeFileSync(join(template, "extensions", "hook.ts"), "用户的扩展");
  writeFileSync(join(template, "themes", "dark.json"), "{}");
  writeFileSync(
    join(template, "settings.json"),
    JSON.stringify({
      defaultModel: "fixture",
      packages: [],
      skills: [join(template, "skills"), "/外部/技能库"],
      extensions: [join(template, "extensions")],
      themes: [join(template, "themes")],
    }),
  );
  return { root, template };
}

test("新建身份拿到自有的技能、扩展和主题，不再引用模板目录", () => {
  const { root, template } = resourceTemplate("atrium-own-res-");
  try {
    const target = prepareProfile("id1", template, join(root, ".pi"));
    const settings = JSON.parse(
      readFileSync(join(target, "settings.json"), "utf8"),
    );
    // Template paths go; the user's explicit outside path stays.
    assert.deepEqual(settings.skills, ["/外部/技能库"]);
    assert.deepEqual(settings.extensions, []);
    assert.deepEqual(settings.themes, []);
    assert.equal(
      readFileSync(join(target, "skills", "写作", "SKILL.md"), "utf8"),
      "用户的写作技能",
    );
    assert.equal(
      readFileSync(join(target, "extensions", "hook.ts"), "utf8"),
      "用户的扩展",
    );
    // Evolving a skill rewrites the identity's copy, not the user's.
    writeFileSync(
      join(target, "skills", "写作", "SKILL.md"),
      "身份改过的写作技能",
    );
    assert.equal(
      readFileSync(join(template, "skills", "写作", "SKILL.md"), "utf8"),
      "用户的写作技能",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("新建身份的技能目录跟随符号链接，克隆后可独立修改", () => {
  const { root, template } = resourceTemplate("atrium-resource-links-");
  try {
    symlinkSync("SKILL.md", join(template, "skills", "写作", "alias.md"));
    const target = prepareProfile("id1", template, join(root, ".pi"));
    const copy = join(target, "skills", "写作", "alias.md");
    assert.equal(lstatSync(copy).isSymbolicLink(), false);
    assert.equal(readFileSync(copy, "utf8"), "用户的写作技能");
    writeFileSync(copy, "身份独立修改");
    assert.equal(
      readFileSync(join(template, "skills", "写作", "SKILL.md"), "utf8"),
      "用户的写作技能",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("新建身份复制模板里的 claude-bridge.json，模板没有就跳过", () => {
  const { root, template } = resourceTemplate("atrium-bridge-config-");
  const source = join(template, "claude-bridge.json");
  const config = JSON.stringify({
    provider: { pathToClaudeCodeExecutable: "/用户/.local/bin/claude" },
  });
  try {
    writeFileSync(source, config);
    const own = join(
      prepareProfile("id1", template, join(root, ".pi")),
      "claude-bridge.json",
    );
    assert(!lstatSync(own).isSymbolicLink(), "是副本，不是链接");
    assert.equal(readFileSync(own, "utf8"), config);
    // The bridge writes its startup-notice date here; only the copy changes.
    writeFileSync(own, "身份写过的配置");
    assert.equal(readFileSync(source, "utf8"), config);
    rmSync(source);
    const bare = prepareProfile("id2", template, join(root, ".pi"));
    assert(existsSync(join(bare, "settings.json")), "模板没有也照常建好");
    assert(!existsSync(join(bare, "claude-bridge.json")), "模板没有就不复制");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("旧身份的共享资源目录转成自有副本，不覆盖已有的", () => {
  const { root, template } = resourceTemplate("atrium-adopt-res-");
  const identity = join(root, "identity");
  mkdirSync(join(identity, "skills", "写作"), { recursive: true });
  writeFileSync(
    join(identity, "skills", "写作", "SKILL.md"),
    "身份早就改过的版本",
  );
  writeFileSync(
    join(identity, "settings.json"),
    JSON.stringify(
      {
        skills: [join(template, "skills")],
        extensions: [join(template, "extensions")],
      },
      null,
      2,
    ),
  );
  const before = walk(template);
  try {
    adoptIdentityConfig(identity, template);
    const settings = JSON.parse(
      readFileSync(join(identity, "settings.json"), "utf8"),
    );
    assert.deepEqual(settings.skills, []);
    assert.deepEqual(settings.extensions, []);
    // The identity's own version survives; what it lacked was copied in.
    assert.equal(
      readFileSync(join(identity, "skills", "写作", "SKILL.md"), "utf8"),
      "身份早就改过的版本",
    );
    assert.equal(
      readFileSync(join(identity, "extensions", "hook.ts"), "utf8"),
      "用户的扩展",
    );
    assert.deepEqual(walk(template), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("资源目录是符号链接时拒绝，不写进用户技能库，引用保留", () => {
  const { root, template } = resourceTemplate("atrium-res-linked-");
  const identity = join(root, "identity");
  mkdirSync(identity, { recursive: true });
  const shared = [join(template, "skills")];
  writeFileSync(
    join(identity, "settings.json"),
    JSON.stringify({ skills: shared }, null, 2),
  );
  symlinkSync(join(template, "skills"), join(identity, "skills"));
  const before = walk(template);
  try {
    assert.throws(
      () => adoptIdentityConfig(identity, template),
      (error: unknown) =>
        error instanceof Problem && String(error.message).includes("skills"),
    );
    assert.deepEqual(walk(template), before);
    // The reference stays, so the identity still finds its skills.
    assert.deepEqual(
      JSON.parse(readFileSync(join(identity, "settings.json"), "utf8")).skills,
      shared,
    );
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
