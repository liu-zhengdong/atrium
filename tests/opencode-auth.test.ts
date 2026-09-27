import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isApiKeyEntry,
  mcpHint,
  oauthHint,
  oauthOnly,
  planAuthFile,
} from "../cli/opencode-auth.ts";

const parsed = (plan: { content?: string }) =>
  JSON.parse(plan.content ?? "null") as unknown;

test("API key 类条目：api 要有 key，wellknown 要有 key 与 token，其余都不算", () => {
  assert.equal(isApiKeyEntry({ type: "api", key: "k" }), true);
  assert.equal(isApiKeyEntry({ type: "api", key: "" }), false);
  assert.equal(isApiKeyEntry({ type: "api" }), false);
  assert.equal(
    isApiKeyEntry({ type: "wellknown", key: "k", token: "t" }),
    true,
  );
  assert.equal(isApiKeyEntry({ type: "wellknown", key: "k" }), false);
  assert.equal(
    isApiKeyEntry({ type: "oauth", refresh: "r", access: "a", expires: 1 }),
    false,
  );
  for (const odd of [null, "k", 1, [], { key: "k" }, { type: "API", key: "k" }])
    assert.equal(isApiKeyEntry(odd), false);
});

test("混合条目：只带 API key，OAuth 与拿不准的都不带并分别记下", () => {
  const plan = planAuthFile(
    "auth.json",
    JSON.stringify({
      zai: { type: "api", key: "z" },
      site: { type: "wellknown", key: "k", token: "t" },
      openai: {
        type: "oauth",
        refresh: "r",
        access: "a",
        expires: 1,
        accountId: "u",
      },
      xai: { type: "oauth", refresh: "r2", access: "a2", expires: 1 },
      weird: { type: "future", secret: "s" },
      broken: "text",
    }),
    undefined,
  );
  assert.deepEqual(parsed(plan), {
    zai: { type: "api", key: "z" },
    site: { type: "wellknown", key: "k", token: "t" },
  });
  assert.deepEqual(plan.synced, ["zai", "site"]);
  assert.deepEqual(plan.skipped, [
    { name: "openai", reason: "oauth" },
    { name: "xai", reason: "oauth" },
    { name: "weird", reason: "uncertain" },
    { name: "broken", reason: "uncertain" },
  ]);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(oauthOnly(plan), ["openai", "xai"]);
  assert.ok(!plan.content!.includes('"r"'), "OAuth 令牌不进秘书那份");
});

test("mcp-auth.json：OAuth 状态（tokens、clientInfo、codeVerifier）一概不带", () => {
  const plan = planAuthFile(
    "mcp-auth.json",
    JSON.stringify({
      notion: {
        clientInfo: { clientId: "c" },
        codeVerifier: "v",
        oauthState: "s",
        serverUrl: "https://x",
      },
      linear: {
        tokens: { accessToken: "a", refreshToken: "r" },
        serverUrl: "https://y",
      },
      plain: { serverUrl: "https://z" },
    }),
    undefined,
  );
  assert.deepEqual(parsed(plan), {});
  assert.deepEqual(plan.skipped, [
    { name: "notion", reason: "oauth" },
    { name: "linear", reason: "oauth" },
    { name: "plain", reason: "uncertain" },
  ]);
  assert.match(mcpHint("/h", plan.skipped)!, /notion、linear、plain/);
  assert.equal(mcpHint("/h", []), undefined);
});

test("#318 整份拷来的 OAuth 被清掉；秘书自己的登录保留；上次同步来的随用户删除", () => {
  const user = {
    a: { type: "api", key: "sk" },
    openai: { type: "oauth", refresh: "r", access: "a", expires: 1 },
    xai: { type: "oauth", refresh: "rx", access: "ax", expires: 1 },
  };
  // 秘书刷新过 xai：refresh 不同但 access 仍是用户那份的，也算拷来的。
  const secretary = {
    ...user,
    xai: { type: "oauth", refresh: "rx2", access: "ax", expires: 2 },
    google: { type: "oauth", refresh: "own", access: "own", expires: 3 },
    gone: { type: "api", key: "old" },
  };
  const plan = planAuthFile(
    "auth.json",
    JSON.stringify(user),
    JSON.stringify(secretary),
    ["gone"],
  );
  assert.deepEqual(parsed(plan), {
    google: secretary.google,
    a: user.a,
  });
  assert.deepEqual(oauthOnly(plan), ["openai", "xai"]);

  // 用户那边也有 API key 时以用户的为准；秘书自己登录的提供商不算「只有 OAuth」。
  const both = planAuthFile(
    "auth.json",
    JSON.stringify({ google: { type: "oauth", refresh: "u", access: "u" } }),
    JSON.stringify({ google: secretary.google }),
  );
  assert.deepEqual(parsed(both), { google: secretary.google });
  assert.deepEqual(oauthOnly(both), []);
});

test("坏文件：用户那份坏了不动秘书那份，秘书那份坏了按空重建；没有文件按空", () => {
  for (const bad of ["{坏", "[]", "null", '"x"']) {
    const plan = planAuthFile("auth.json", bad, '{"a":1}', ["a"]);
    assert.equal(plan.content, undefined);
    assert.deepEqual(plan.synced, ["a"], "上次同步记录保留");
    assert.equal(plan.problems.length, 1);
    assert.match(plan.problems[0]!, /用户的 opencode auth\.json/);
  }
  const rebuilt = planAuthFile(
    "auth.json",
    JSON.stringify({ a: { type: "api", key: "k" } }),
    "{坏",
  );
  assert.deepEqual(parsed(rebuilt), { a: { type: "api", key: "k" } });
  assert.match(rebuilt.problems[0]!, /秘书的 auth\.json 不是合法 JSON/);

  const empty = planAuthFile("auth.json", undefined, undefined);
  assert.deepEqual(parsed(empty), {});
  assert.deepEqual(empty.problems, []);
});

test("提示：知道模型时只在其提供商只有 OAuth 时提示；不知道时列出只有 OAuth 的提供商", () => {
  const home = "/data/secretary/opencode-home";
  const hint = oauthHint(home, ["openai", "xai"], "openai/gpt-5");
  assert.match(hint!, /openai\/gpt-5/);
  assert.match(hint!, /API key/);
  assert.match(
    hint!,
    /XDG_DATA_HOME=\/data\/secretary\/opencode-home opencode auth login/,
  );
  assert.equal(oauthHint(home, ["openai"], "zai/glm"), undefined);
  assert.match(oauthHint(home, ["openai", "xai"])!, /openai、xai/);
  assert.equal(oauthHint(home, []), undefined);
});
