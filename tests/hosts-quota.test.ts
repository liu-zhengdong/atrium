import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeHostReadings } from "../server/quota-readers/merge.ts";
import type { ReaderOutcome } from "../server/quota-readers/index.ts";
import { accountKey } from "../server/quota-readers/credentials.ts";
import { claudeAccount } from "../server/quota-readers/claude.ts";
import { parseCodexLogin } from "../server/quota-readers/codex.ts";
import { claudeAccountFile } from "../server/quota-readers/paths.ts";
import { usableByProvider } from "../server/tasks/quota-source.ts";

/** 额度多主机合并（#358 第 2 步）：按账号合并、CLI 能在哪几台用、账号指纹。纯函数穷举。 */

const noteOf = (outcome: ReaderOutcome) =>
  outcome.ok ? outcome.note : undefined;

const good = (
  refreshedAt: number,
  account: string | null,
  used = 10,
): ReaderOutcome => ({
  ok: true,
  result: {
    ok: true,
    plan: "Pro",
    windows: [
      {
        id: "weekly",
        label: "Weekly",
        usedPercent: used,
        resetsAt: null,
        periodSeconds: 604800,
      },
    ],
    refreshedAt,
    account,
  },
  note: null,
});

test("额度多主机合并：同一账号只算一份取最新；认不出账号按主机分开；本机账号优先；别的账号写明没算", () => {
  const now = 10_000_000;
  // 同一账号在 h1、h2 都读到：取 h2 更新的那份，不加说明。
  let merged = mergeHostReadings({
    local: "h1",
    localReadings: new Map([["codex", good(now - 5000, "aaaa1111", 10)]]),
    reports: [
      {
        host: "h2",
        readings: [
          { provider: "codex", outcome: good(now - 1000, "aaaa1111", 30) },
        ],
      },
    ],
    now,
  });
  let codex = merged.get("codex")!;
  assert.equal(codex.from, "h2");
  assert.ok(codex.outcome.ok);
  assert.equal(
    codex.outcome.ok && codex.outcome.result.windows[0]!.usedPercent,
    30,
  );
  assert.equal(noteOf(codex.outcome), null);
  // 本机读不到、h2 读到：用 h2 的，说明读自 h2。
  merged = mergeHostReadings({
    local: "h1",
    localReadings: new Map([["claude", { ok: false, reason: "没登录" }]]),
    reports: [
      {
        host: "h2",
        readings: [{ provider: "claude", outcome: good(now, "bbbb2222") }],
      },
    ],
    now,
  });
  assert.equal(merged.get("claude")!.from, "h2");
  assert.equal(noteOf(merged.get("claude")!.outcome), "读自 h2");
  // 两台是不同账号：本机那个算数，另一个写明没算进来。
  merged = mergeHostReadings({
    local: "h1",
    localReadings: new Map([["codex", good(now - 9000, "aaaa1111")]]),
    reports: [
      {
        host: "h2",
        readings: [{ provider: "codex", outcome: good(now, "cccc3333") }],
      },
      {
        host: "h3",
        readings: [{ provider: "codex", outcome: good(now, "cccc3333") }],
      },
    ],
    now,
  });
  codex = merged.get("codex")!;
  assert.equal(codex.from, "h1");
  assert.equal(noteOf(codex.outcome), "h2、h3 登录的是另一个账号，没算进来");
  // 认不出账号的读数按主机各算各的；本机没有时取最新的那台。
  merged = mergeHostReadings({
    local: "h1",
    localReadings: new Map(),
    reports: [
      {
        host: "h2",
        readings: [{ provider: "opencode", outcome: good(now - 50, null) }],
      },
      {
        host: "h3",
        readings: [{ provider: "opencode", outcome: good(now - 10, null) }],
      },
    ],
    now,
  });
  assert.equal(merged.get("opencode")!.from, "h3");
  // 读数太旧不用；都读不到时给本机的原因。
  merged = mergeHostReadings({
    local: "h1",
    localReadings: new Map([["codex", { ok: false, reason: "本机没登录" }]]),
    reports: [
      {
        host: "h2",
        readings: [
          { provider: "codex", outcome: good(now - 7 * 3600_000, "a1") },
        ],
      },
    ],
    now,
  });
  assert.deepEqual(merged.get("codex"), {
    outcome: { ok: false, reason: "本机没登录" },
    from: null,
  });
  // 本机没读（自带读取关着）、只有别的主机读不到：写明是哪台的原因。
  merged = mergeHostReadings({
    local: "h1",
    localReadings: new Map(),
    reports: [
      {
        host: "h2",
        readings: [
          {
            provider: "claude",
            outcome: { ok: false, reason: "没有找到登录" },
          },
        ],
      },
    ],
    now,
  });
  assert.deepEqual(merged.get("claude"), {
    outcome: { ok: false, reason: "没有找到登录（h2）" },
    from: null,
  });
  // 本机的读数不会被自称 h1 的上报顶掉。
  merged = mergeHostReadings({
    local: "h1",
    localReadings: new Map([["codex", good(now - 100, "a1")]]),
    reports: [
      {
        host: "h1",
        readings: [{ provider: "codex", outcome: good(now, "zz") }],
      },
    ],
    now,
  });
  assert.equal(noteOf(merged.get("codex")!.outcome), null);
});

test("CLI 能在哪几台用：按 provider 把同一家的几个工具合起来", () => {
  const usable = usableByProvider({
    usable: [
      { host: "h1", tools: ["claude", "codex"] },
      { host: "h2", tools: ["codex", "opencode"] },
      { host: "h3", tools: [] },
    ],
  });
  assert.deepEqual(usable.get("claude"), ["h1"]);
  assert.deepEqual(usable.get("codex"), ["h1", "h2"]);
  assert.deepEqual(usable.get("opencode"), ["h2"]);
});

test("账号指纹：不可逆、不含账号 id 与令牌；claude 看 .claude.json 的账号，codex 看用户 + 账号", () => {
  const key = accountKey("claude", "uuid-1:org-1");
  assert.match(key, /^[a-f0-9]{16}$/);
  assert.notEqual(key, accountKey("codex", "uuid-1:org-1"));
  assert.equal(
    claudeAccount(
      JSON.stringify({
        oauthAccount: { accountUuid: "uuid-1", organizationUuid: "org-1" },
      }),
    ),
    key,
  );
  assert.equal(claudeAccount(JSON.stringify({ projects: {} })), null);
  assert.equal(claudeAccount("not json"), null);
  assert.equal(claudeAccount(undefined), null);
  assert.equal(
    claudeAccountFile("linux", "/home/u", {}),
    "/home/u/.claude.json",
  );
  assert.equal(
    claudeAccountFile("win32", "C:\\Users\\u", { CLAUDE_CONFIG_DIR: "D:\\cc" }),
    "D:\\cc\\.claude.json",
  );
  const idToken = (claims: object) =>
    `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
  const login = (tokens: object) =>
    parseCodexLogin(
      JSON.stringify({ tokens: { access_token: "secret-token", ...tokens } }),
    );
  const a = login({
    account_id: "acct-1",
    id_token: idToken({
      "https://api.openai.com/auth": { chatgpt_user_id: "user-1" },
    }),
  });
  const b = login({
    account_id: "acct-1",
    id_token: idToken({
      "https://api.openai.com/auth": { chatgpt_user_id: "user-2" },
    }),
  });
  assert.ok(a && !a.apiKeyOnly && b && !b.apiKeyOnly);
  // 同一工作区的两个人额度各算各的。
  assert.notEqual(a.account, b.account);
  assert.equal(a.account, accountKey("codex", "user-1:acct-1"));
  assert.doesNotMatch(a.account ?? "", /secret|acct|user/);
  const none = login({});
  assert.ok(none && !none.apiKeyOnly);
  assert.equal(none.account, null);
});
