import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  linkSharedCredentials,
  prepareProfile,
  syncIdentityProfile,
} from "../server/profile.ts";

const TEMPLATE_LOGIN = {
  "kimi-coding": { type: "oauth", access: "模板里登录的令牌" },
};

/** A template the user has already logged in once. */
function credentialTemplate(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const template = join(root, "template");
  mkdirSync(template, { recursive: true });
  writeFileSync(
    join(template, "settings.json"),
    JSON.stringify({ defaultModel: "fixture", packages: [] }),
  );
  writeFileSync(join(template, "auth.json"), JSON.stringify(TEMPLATE_LOGIN));
  return { root, template };
}

/**
 * What Pi does to auth.json: create it if the path resolves to nothing, then
 * write the whole file in place. Copied from dist/core/auth-storage.js so the
 * tests exercise the real write shape rather than an assumption about it.
 */
function piWriteCredentials(path: string, value: unknown) {
  if (!existsSync(path)) writeFileSync(path, "{}", { mode: 0o600 });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

const credentials = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as unknown;

test("新建身份的 auth.json 指向模板，直接读到已有登录", () => {
  const { root, template } = credentialTemplate("atrium-auth-new-");
  try {
    const target = prepareProfile("id1", template, join(root, ".pi"));
    const own = join(target, "auth.json");
    assert(lstatSync(own).isSymbolicLink());
    assert.equal(readlinkSync(own), join(template, "auth.json"));
    assert.deepEqual(credentials(own), TEMPLATE_LOGIN);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("一个身份刷新令牌，另一个身份立刻读到，软链接不断", () => {
  const { root, template } = credentialTemplate("atrium-auth-share-");
  try {
    const one = prepareProfile("id1", template, join(root, ".pi"));
    const two = prepareProfile("id2", template, join(root, ".pi"));
    const refreshed = {
      "kimi-coding": { type: "oauth", access: "刷新后的令牌" },
    };
    piWriteCredentials(join(one, "auth.json"), refreshed);
    // The write lands in the shared file and leaves the link in place.
    assert(lstatSync(join(one, "auth.json")).isSymbolicLink());
    assert.deepEqual(credentials(join(template, "auth.json")), refreshed);
    assert.deepEqual(credentials(join(two, "auth.json")), refreshed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("模板还没有 auth.json：链接照建，第一次登录后全体可用", () => {
  const { root, template } = credentialTemplate("atrium-auth-first-");
  rmSync(join(template, "auth.json"));
  try {
    const one = prepareProfile("id1", template, join(root, ".pi"));
    const two = prepareProfile("id2", template, join(root, ".pi"));
    assert(lstatSync(join(one, "auth.json")).isSymbolicLink());
    const login = { deepseek: { type: "api_key", key: "在身份里登录的" } };
    piWriteCredentials(join(one, "auth.json"), login);
    assert.deepEqual(credentials(join(template, "auth.json")), login);
    assert.deepEqual(credentials(join(two, "auth.json")), login);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("已建身份启动：空 auth.json 换成软链接，拿到模板里的登录", (t) => {
  const { root, template } = credentialTemplate("atrium-auth-adopt-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.ATRIUM_PI_TEMPLATE;
  process.env.ATRIUM_PI_TEMPLATE = template;
  t.after(() => {
    if (previous === undefined) delete process.env.ATRIUM_PI_TEMPLATE;
    else process.env.ATRIUM_PI_TEMPLATE = previous;
  });
  const identity = join(root, "identity");
  mkdirSync(identity, { recursive: true });
  writeFileSync(
    join(identity, "settings.json"),
    JSON.stringify({ packages: [] }),
  );
  // What the five existing identities hold: the empty file Pi created.
  writeFileSync(join(identity, "auth.json"), "{}");
  assert.deepEqual(syncIdentityProfile(identity), []);
  assert(lstatSync(join(identity, "auth.json")).isSymbolicLink());
  assert.deepEqual(credentials(join(identity, "auth.json")), TEMPLATE_LOGIN);
  // Starting again changes nothing.
  assert.deepEqual(syncIdentityProfile(identity), []);
  assert.equal(linkSharedCredentials(identity, template), false);
  assert.deepEqual(credentials(join(identity, "auth.json")), TEMPLATE_LOGIN);
});

test("一个字节都没有的 auth.json 也算没登录", () => {
  const { root, template } = credentialTemplate("atrium-auth-blank-");
  try {
    const identity = join(root, "identity");
    mkdirSync(identity, { recursive: true });
    writeFileSync(join(identity, "auth.json"), "");
    assert.equal(linkSharedCredentials(identity, template), true);
    assert.deepEqual(credentials(join(identity, "auth.json")), TEMPLATE_LOGIN);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("身份自己的登录不被顶掉：有内容的 auth.json 原样保留", () => {
  const { root, template } = credentialTemplate("atrium-auth-keep-");
  try {
    const own = { deepseek: { type: "api_key", key: "这个身份单独登录的" } };
    for (const [name, content] of [
      ["logged-in", JSON.stringify(own)],
      // Unreadable content is still content: replacing it would lose a login.
      ["broken", "{坏掉的 JSON"],
      ["not-an-object", '"字符串"'],
    ] as const) {
      const identity = join(root, name);
      mkdirSync(identity, { recursive: true });
      writeFileSync(join(identity, "auth.json"), content);
      assert.equal(linkSharedCredentials(identity, template), false);
      assert(!lstatSync(join(identity, "auth.json")).isSymbolicLink());
      assert.equal(readFileSync(join(identity, "auth.json"), "utf8"), content);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("指向别处的软链接是用户自己配的，保留", () => {
  const { root, template } = credentialTemplate("atrium-auth-elsewhere-");
  try {
    const separate = join(root, "separate-auth.json");
    writeFileSync(separate, JSON.stringify({ deepseek: { type: "api_key" } }));
    const identity = join(root, "identity");
    mkdirSync(identity, { recursive: true });
    symlinkSync(separate, join(identity, "auth.json"));
    assert.equal(linkSharedCredentials(identity, template), false);
    assert.equal(readlinkSync(join(identity, "auth.json")), separate);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("模板目录本身当身份目录时不自链", () => {
  const { root, template } = credentialTemplate("atrium-auth-self-");
  try {
    assert.equal(linkSharedCredentials(template, template), false);
    assert(!lstatSync(join(template, "auth.json")).isSymbolicLink());
    assert.deepEqual(credentials(join(template, "auth.json")), TEMPLATE_LOGIN);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
