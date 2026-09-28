import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../server/app.ts";
import {
  claudePlan,
  CLAUDE_USAGE_URL,
  mapClaudeUsage,
  readClaude,
} from "../server/quota-readers/claude.ts";
import {
  CODEX_USAGE_URL,
  codexPlan,
  mapCodexUsage,
  readCodex,
} from "../server/quota-readers/codex.ts";
import {
  FAILED_TTL_MS,
  LAST_GOOD_MS,
  OK_TTL_MS,
  QuotaReaders,
  outcomeOf,
  readersEnabled,
  type ReaderOutcome,
} from "../server/quota-readers/index.ts";
import { hasQuotaData, mergeQuotaRows } from "../server/quota-readers/merge.ts";
import {
  mapOpencodeUsage,
  OPENCODE_USAGE_URL,
  readOpencode,
} from "../server/quota-readers/opencode.ts";
import {
  comparisonWindow,
  paceRow,
  periodElapsedPercent,
  round1,
  shortWindow,
} from "../server/quota-readers/pace.ts";
import {
  claudeSources,
  codexSources,
  expandHome,
  opencodeSources,
  scopedClaudeService,
} from "../server/quota-readers/paths.ts";
import type {
  QuotaWindow,
  ReadOk,
  ReadResult,
  Reader,
  ReaderDeps,
} from "../server/quota-readers/types.ts";
import {
  parsePace,
  readPace,
  spareByProvider,
} from "../server/tasks/prepare.ts";
import { listQuota, type QuotaList } from "../server/tasks/quota.ts";
import { removeTemp } from "./temp-dir.ts";
import { writeFakeBin } from "./fake-bin.ts";

const HOUR = 3_600_000;
const WEEK_S = 7 * 24 * 3600;
const NOW = Date.parse("2026-09-27T11:00:00Z");
const SECRET = "sk-ant-oat01-SECRET-TOKEN-should-never-leak";

type Reply = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

/** 假依赖：文件与钥匙串都是内存表，接口按 URL 回放；记录每次请求的 URL 与请求头。 */
function fakeDeps(
  options: {
    platform?: ReaderDeps["platform"];
    home?: string;
    env?: Record<string, string>;
    files?: Record<string, string>;
    unreadable?: string[];
    keychain?: Record<string, string>;
    replies?: Record<string, Reply | "timeout" | "network">;
    now?: () => number;
  } = {},
) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const deps: ReaderDeps = {
    platform: options.platform ?? "linux",
    home: options.home ?? "/home/u",
    env: options.env ?? {},
    async readFile(path) {
      if (options.unreadable?.includes(path)) throw new Error("EACCES");
      return options.files?.[path];
    },
    async keychain(service, account) {
      return options.keychain?.[`${service}|${account}`];
    },
    fetch: (async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        ),
      });
      const reply = options.replies?.[url];
      if (reply === "timeout")
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal!.reason),
          );
        });
      if (!reply || reply === "network") throw new TypeError("fetch failed");
      return new Response(
        typeof reply.body === "string"
          ? reply.body
          : JSON.stringify(reply.body ?? null),
        { status: reply.status, headers: reply.headers },
      );
    }) as typeof fetch,
    now: options.now ?? (() => NOW),
    timeoutMs: 30,
  };
  return { deps, requests };
}

const noLeak = (value: unknown) =>
  assert.doesNotMatch(JSON.stringify(value), /SECRET/);

function jwt(exp: number) {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp: Math.floor(exp / 1000), note: "SECRET" })}.sig`;
}

// —— 路径判定：三个平台都测，不依赖运行平台 ——

test("路径：Claude Code 在 macOS 先钥匙串再凭据文件，Linux 查 ~/.claude 与 XDG，Windows 查用户目录", () => {
  assert.deepEqual(claudeSources("darwin", "/Users/u", { USER: "u" }), [
    { kind: "keychain", service: "Claude Code-credentials", account: "u" },
    { kind: "keychain", service: "Claude Code-credentials", account: "" },
    { kind: "file", path: "/Users/u/.claude/.credentials.json" },
  ]);
  assert.deepEqual(claudeSources("darwin", "/Users/u", {}), [
    { kind: "keychain", service: "Claude Code-credentials", account: "" },
    { kind: "file", path: "/Users/u/.claude/.credentials.json" },
  ]);
  assert.deepEqual(claudeSources("linux", "/home/u", {}), [
    { kind: "file", path: "/home/u/.claude/.credentials.json" },
    { kind: "file", path: "/home/u/.config/claude/.credentials.json" },
  ]);
  assert.deepEqual(
    claudeSources("linux", "/home/u", { XDG_CONFIG_HOME: "/xdg" }),
    [
      { kind: "file", path: "/home/u/.claude/.credentials.json" },
      { kind: "file", path: "/xdg/claude/.credentials.json" },
    ],
  );
  assert.deepEqual(claudeSources("win32", "C:\\Users\\u", {}), [
    { kind: "file", path: "C:\\Users\\u\\.claude\\.credentials.json" },
  ]);
  // CLAUDE_CONFIG_DIR 设了只认它；macOS 另查按目录派生的钥匙串项。
  assert.deepEqual(
    claudeSources("linux", "/home/u", { CLAUDE_CONFIG_DIR: "~/work" }),
    [{ kind: "file", path: "/home/u/work/.credentials.json" }],
  );
  assert.deepEqual(
    claudeSources("win32", "C:\\Users\\u", { CLAUDE_CONFIG_DIR: "D:\\cc" }),
    [{ kind: "file", path: "D:\\cc\\.credentials.json" }],
  );
  const scoped = claudeSources("darwin", "/Users/u", {
    CLAUDE_CONFIG_DIR: "/Users/u/.claude-work",
    USER: "u",
  });
  assert.deepEqual(
    scoped.map((source) =>
      source.kind === "file" ? source.path : source.service,
    ),
    [
      scopedClaudeService("/Users/u/.claude-work"),
      scopedClaudeService("/Users/u/.claude-work"),
      "Claude Code-credentials",
      "Claude Code-credentials",
      "/Users/u/.claude-work/.credentials.json",
    ],
  );
  assert.match(
    scopedClaudeService("/Users/u/.claude-work"),
    /^Claude Code-credentials-[0-9a-f]{8}$/,
  );
  assert.equal(
    scopedClaudeService("C:\\x"),
    scopedClaudeService("C:/x"),
    "反斜杠按正斜杠算",
  );
});

test("路径：Codex 三个平台都查 ~/.config/codex 与 ~/.codex，CODEX_HOME 设了只认它", () => {
  assert.deepEqual(codexSources("darwin", "/Users/u", {}), [
    { kind: "file", path: "/Users/u/.config/codex/auth.json" },
    { kind: "file", path: "/Users/u/.codex/auth.json" },
  ]);
  assert.deepEqual(codexSources("linux", "/home/u", {}), [
    { kind: "file", path: "/home/u/.config/codex/auth.json" },
    { kind: "file", path: "/home/u/.codex/auth.json" },
  ]);
  assert.deepEqual(codexSources("win32", "C:\\Users\\u", {}), [
    { kind: "file", path: "C:\\Users\\u\\.config\\codex\\auth.json" },
    { kind: "file", path: "C:\\Users\\u\\.codex\\auth.json" },
  ]);
  assert.deepEqual(codexSources("linux", "/home/u", { CODEX_HOME: " /c " }), [
    { kind: "file", path: "/c/auth.json" },
  ]);
  assert.deepEqual(
    codexSources("win32", "C:\\Users\\u", { CODEX_HOME: "~\\cx" }),
    [{ kind: "file", path: "C:\\Users\\u\\cx\\auth.json" }],
  );
  assert.deepEqual(codexSources("linux", "/home/u", { CODEX_HOME: "  " }), [
    { kind: "file", path: "/home/u/.config/codex/auth.json" },
    { kind: "file", path: "/home/u/.codex/auth.json" },
  ]);
});

test("路径：OpenCode 按 OPENCODE_DATA_DIR → XDG_DATA_HOME → ~/.local/share/opencode", () => {
  for (const [platform, home, expected] of [
    ["darwin", "/Users/u", "/Users/u/.local/share/opencode/auth.json"],
    ["linux", "/home/u", "/home/u/.local/share/opencode/auth.json"],
    [
      "win32",
      "C:\\Users\\u",
      "C:\\Users\\u\\.local\\share\\opencode\\auth.json",
    ],
  ] as const)
    assert.deepEqual(opencodeSources(platform, home, {}), [
      { kind: "file", path: expected },
    ]);
  assert.deepEqual(
    opencodeSources("linux", "/home/u", {
      OPENCODE_DATA_DIR: "~/oc",
      XDG_DATA_HOME: "/xdg",
    }),
    [{ kind: "file", path: "/home/u/oc/auth.json" }],
  );
  assert.deepEqual(
    opencodeSources("linux", "/home/u", { XDG_DATA_HOME: "~/xdg" }),
    [{ kind: "file", path: "/home/u/xdg/opencode/auth.json" }],
  );
  assert.deepEqual(
    opencodeSources("win32", "C:\\Users\\u", { XDG_DATA_HOME: "D:\\data" }),
    [{ kind: "file", path: "D:\\data\\opencode\\auth.json" }],
  );
  assert.equal(expandHome("~", "/h", "linux"), "/h");
  assert.equal(expandHome("~x", "/h", "linux"), "~x");
  assert.equal(expandHome("/abs", "/h", "linux"), "/abs");
});

// —— pace 行：与 OpenQuota 同口径 ——

const weekly = (partial: Partial<QuotaWindow> = {}): QuotaWindow => ({
  id: "weekly",
  label: "Weekly",
  usedPercent: 20,
  resetsAt: NOW + 44 * HOUR,
  periodSeconds: WEEK_S,
  ...partial,
});

test("pace：周窗口已用 20%、44 小时后重置 → 周期进度 73.8、富余 53.8（与 OpenQuota 同时刻读数一致）", () => {
  const row = paceRow({
    providerId: "claude",
    plan: "Max 5x",
    windows: [
      {
        id: "session",
        label: "Session",
        usedPercent: 3,
        resetsAt: NOW + HOUR,
        periodSeconds: 18_000,
      },
      weekly(),
      { ...weekly(), id: "sonnet", label: "Sonnet", usedPercent: 1 },
    ],
    refreshedAt: NOW - 30 * 60_000,
    now: NOW,
  });
  assert.deepEqual(row, {
    providerId: "claude",
    plan: "Max 5x",
    windowId: "weekly",
    windowLabel: "Weekly",
    usedPercent: 20,
    periodElapsedPercent: 73.8,
    sparePercent: 53.8,
    hoursToReset: 44,
    shortWindowId: "session",
    shortWindowUsedPercent: 3,
    refreshedAt: "2026-09-27T10:30:00Z",
    refreshedHoursAgo: 0.5,
    stale: true,
  });
});

test("pace：用量信号不足时周期进度与富余留空", () => {
  const elapsed = (partial: Partial<QuotaWindow>) =>
    periodElapsedPercent(weekly(partial), NOW);
  assert.equal(elapsed({}), (124 / 168) * 100);
  assert.equal(elapsed({ usedPercent: 0 }), null, "零用量");
  assert.equal(elapsed({ usedPercent: 99.6 }), null, "用光");
  assert.equal(elapsed({ usedPercent: 120 }), null, "超过 100 按用光");
  assert.equal(elapsed({ resetsAt: null }), null, "没有重置时刻");
  assert.equal(elapsed({ resetsAt: NOW }), null, "重置时刻已过");
  assert.equal(elapsed({ periodSeconds: 0 }), null, "周期未知");
  assert.equal(
    elapsed({ resetsAt: NOW + WEEK_S * 1000 - 30_000 }),
    null,
    "窗口刚开始",
  );
  // 周期过去 10%：已用 4% 预计 40% → 有值；已用 4% 但只过去 2% → 预计 200% 且不足 5% → 留空。
  assert.equal(
    round1(elapsed({ usedPercent: 4, resetsAt: NOW + WEEK_S * 900 })!),
    10,
  );
  assert.equal(elapsed({ usedPercent: 4, resetsAt: NOW + WEEK_S * 980 }), null);
  assert.equal(
    round1(elapsed({ usedPercent: 50, resetsAt: NOW + WEEK_S * 980 })!),
    2,
    "预计超量但已用不少于 5% 仍给进度",
  );
  const empty = paceRow({
    providerId: "grok",
    plan: null,
    windows: [weekly({ usedPercent: 0 })],
    refreshedAt: NOW,
    now: NOW,
  });
  assert.equal(empty.periodElapsedPercent, null);
  assert.equal(empty.sparePercent, null);
  assert.equal(empty.usedPercent, 0);
  assert.equal(empty.stale, false);
  const none = paceRow({
    providerId: "x",
    plan: null,
    windows: [],
    refreshedAt: NOW,
    now: NOW,
  });
  assert.equal(none.windowId, null);
  assert.equal(none.usedPercent, null);
  assert.equal(none.hoursToReset, null);
  assert.equal(none.shortWindowId, null);
});

test("pace：对比窗口取名字含 week 的最长窗口，短窗取 session 或 6 小时内最短", () => {
  const w = (id: string, periodSeconds: number): QuotaWindow => ({
    id,
    label: id,
    usedPercent: 10,
    resetsAt: null,
    periodSeconds,
  });
  assert.equal(
    comparisonWindow([
      w("session", 18_000),
      w("monthly", 0),
      w("weekly", WEEK_S),
    ])?.id,
    "weekly",
  );
  assert.equal(
    comparisonWindow([w("weekly", WEEK_S), w("sparkWeekly", WEEK_S)])?.id,
    "weekly",
    "等长取先出现的",
  );
  assert.equal(
    comparisonWindow([w("usage", 30 * 86400), w("daily", 86400)])?.id,
    "usage",
  );
  assert.equal(comparisonWindow([]), undefined);
  assert.equal(
    shortWindow([w("weekly", WEEK_S), w("session", 18_000)])?.id,
    "session",
  );
  assert.equal(
    shortWindow([w("a", 3 * 3600), w("b", 3600), w("c", 7 * 3600), w("d", 0)])
      ?.id,
    "b",
  );
  assert.equal(shortWindow([w("weekly", WEEK_S)]), undefined);
  assert.equal(round1(-0.04), 0);
  assert.equal(Object.is(round1(-0.04), -0), false, "不出现 -0");
  assert.equal(round1(-13.65), -13.7, "远离零取整");
  assert.equal(round1(53.84), 53.8);
});

// —— Claude ——

const CLAUDE_LOGIN = JSON.stringify({
  claudeAiOauth: {
    accessToken: SECRET,
    refreshToken: "SECRET-refresh",
    expiresAt: NOW + HOUR,
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_5x",
    scopes: ["user:profile", "user:inference"],
  },
});

const CLAUDE_USAGE = {
  five_hour: { utilization: 3, resets_at: "2026-09-27T12:00:00.123456+00:00" },
  seven_day: { utilization: 20, resets_at: "2026-09-29T07:00:00Z" },
  seven_day_sonnet: { utilization: 1, resets_at: "2026-09-29T07:00:00Z" },
  limits: [
    {
      kind: "weekly_scoped",
      scope: { model: { display_name: "Fable" } },
      percent: 12,
      resets_at: "2026-10-01T00:00:00Z",
    },
    {
      kind: "daily_scoped",
      scope: { model: { display_name: "Opus 5.5" } },
      percent: "7",
    },
    { kind: "weekly_scoped", scope: { model: {} }, percent: 56 },
    { kind: "other", percent: 1 },
  ],
  extra_usage: { is_enabled: true, used_credits: 100, monthly_limit: 1000 },
};

test("Claude：macOS 读钥匙串登录，带令牌调用量接口，折成窗口与套餐", async () => {
  const { deps, requests } = fakeDeps({
    platform: "darwin",
    home: "/Users/u",
    env: { USER: "u" },
    keychain: {
      "Claude Code-credentials|u": Buffer.from(CLAUDE_LOGIN).toString("hex"),
    },
    replies: { [CLAUDE_USAGE_URL]: { status: 200, body: CLAUDE_USAGE } },
  });
  const result = await readClaude(deps);
  assert.equal(result.ok, true);
  const ok = result as ReadOk;
  assert.equal(ok.plan, "Max 5x");
  assert.deepEqual(
    ok.windows.map((w) => [w.id, w.usedPercent, w.periodSeconds]),
    [
      ["session", 3, 18_000],
      ["weekly", 20, WEEK_S],
      ["sonnet", 1, WEEK_S],
      ["fable", 12, WEEK_S],
      ["scoped-daily-opus-5-5", 7, 86_400],
    ],
  );
  assert.equal(ok.windows[0]!.resetsAt, Date.parse("2026-09-27T12:00:00.123Z"));
  assert.equal(ok.refreshedAt, NOW);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(requests[0]!.headers["anthropic-beta"], "oauth-2025-04-20");
});

test("Claude：Linux 读 ~/.claude/.credentials.json；缺失、过期、读不出各有中文原因", async () => {
  const path = "/home/u/.claude/.credentials.json";
  const ok = await readClaude(
    fakeDeps({
      files: { [path]: CLAUDE_LOGIN },
      replies: { [CLAUDE_USAGE_URL]: { status: 200, body: CLAUDE_USAGE } },
    }).deps,
  );
  assert.equal(ok.ok, true);

  const missing = fakeDeps();
  assert.deepEqual(await readClaude(missing.deps), {
    ok: false,
    reason: "没有找到 Claude Code 登录，运行 claude 登录",
  });
  assert.equal(missing.requests.length, 0);

  const expiredLogin = JSON.parse(CLAUDE_LOGIN);
  expiredLogin.claudeAiOauth.expiresAt = NOW - 1;
  const expired = fakeDeps({ files: { [path]: JSON.stringify(expiredLogin) } });
  const result = await readClaude(expired.deps);
  assert.equal(result.ok, false);
  assert.match(
    (result as { reason: string }).reason,
    /登录已过期.*\.credentials\.json.*运行一次 claude/,
  );
  assert.equal(expired.requests.length, 0, "过期不发请求，也不替它刷新");
  noLeak(result);

  for (const broken of [
    "not json",
    "[]",
    '{"claudeAiOauth":{"accessToken":"  "}}',
  ])
    assert.deepEqual(
      await readClaude(fakeDeps({ files: { [path]: broken } }).deps),
      { ok: false, reason: "Claude Code 登录数据读不出，运行 claude 重新登录" },
    );
  assert.deepEqual(await readClaude(fakeDeps({ unreadable: [path] }).deps), {
    ok: false,
    reason: "Claude Code 登录数据读不出，运行 claude 重新登录",
  });
});

test("Claude：接口报错、限流、超时、结构变了都不回显令牌", async () => {
  const path = "/home/u/.claude/.credentials.json";
  const read = (reply: Reply | "timeout" | "network") =>
    readClaude(
      fakeDeps({
        files: { [path]: CLAUDE_LOGIN },
        replies: { [CLAUDE_USAGE_URL]: reply },
      }).deps,
    );
  const cases: [Reply | "timeout" | "network", ReadResult][] = [
    [
      { status: 401, body: { error: SECRET } },
      {
        ok: false,
        reason: "Claude 用量接口拒绝了登录（令牌失效），运行 claude 重新登录",
      },
    ],
    [
      { status: 500, body: `oops ${SECRET}` },
      { ok: false, reason: "Claude 用量接口返回 HTTP 500" },
    ],
    [
      { status: 429, headers: { "retry-after": "120" } },
      { ok: false, reason: "Claude 用量接口限流", retryAt: NOW + 120_000 },
    ],
    [
      { status: 429 },
      { ok: false, reason: "Claude 用量接口限流", retryAt: NOW + 5 * 60_000 },
    ],
    ["timeout", { ok: false, reason: "Claude 用量接口超时" }],
    ["network", { ok: false, reason: "连不上 Claude 用量接口" }],
    [
      { status: 200, body: { unexpected: SECRET } },
      { ok: false, reason: "Claude 用量接口返回的结构认不出" },
    ],
    [
      { status: 200, body: `<html>${SECRET}</html>` },
      { ok: false, reason: "Claude 用量接口返回的结构认不出" },
    ],
  ];
  for (const [reply, expected] of cases) {
    const result = await read(reply);
    assert.deepEqual(result, expected);
    noLeak(result);
  }
});

test("Claude：套餐名与窗口映射的边界", () => {
  assert.equal(claudePlan("max", "default_claude_max_20x"), "Max 20x");
  assert.equal(claudePlan("pro", null), "Pro");
  assert.equal(claudePlan("team premium", "x"), "Team Premium");
  assert.equal(claudePlan(null, "default_claude_max_5x"), null);
  assert.equal(mapClaudeUsage([]), undefined);
  assert.equal(mapClaudeUsage({}), undefined, "一个窗口都没有当结构变了");
  assert.deepEqual(
    mapClaudeUsage({ five_hour: { utilization: 0, resets_at: 1790000000 } }),
    [
      {
        id: "session",
        label: "Session",
        usedPercent: 0,
        resetsAt: 1_790_000_000_000,
        periodSeconds: 18_000,
      },
    ],
  );
  assert.equal(
    mapClaudeUsage({
      five_hour: { utilization: 1, resets_at: "2099-06-01T12:00:00" },
    })![0]!.resetsAt,
    Date.parse("2099-06-01T12:00:00Z"),
    "无时区按 UTC",
  );
});

// —— Codex ——

const codexAuth = (token: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: token,
      refresh_token: "SECRET-refresh",
      id_token: "SECRET-id",
      account_id: "acct-1",
    },
    last_refresh: "2026-09-23T12:58:50Z",
    ...extra,
  });

const CODEX_USAGE = {
  plan_type: "prolite",
  rate_limit: {
    primary_window: {
      used_percent: 24,
      limit_window_seconds: WEEK_S,
      reset_after_seconds: 150 * 3600,
    },
    secondary_window: null,
  },
  additional_rate_limits: [
    {
      limit_name: "GPT-5-Codex-Spark",
      rate_limit: {
        primary_window: {
          used_percent: 5,
          limit_window_seconds: 18_000,
          reset_at: 1_790_600_000,
        },
      },
    },
  ],
};

test("Codex：读 ~/.codex/auth.json，带账号头调用量接口；只剩周窗口时从 primary 认出周窗口", async () => {
  const token = jwt(NOW + 5 * 24 * HOUR);
  const { deps, requests } = fakeDeps({
    platform: "win32",
    home: "C:\\Users\\u",
    files: { "C:\\Users\\u\\.codex\\auth.json": codexAuth(token) },
    replies: { [CODEX_USAGE_URL]: { status: 200, body: CODEX_USAGE } },
  });
  const result = (await readCodex(deps)) as ReadOk;
  assert.equal(result.ok, true);
  assert.equal(result.plan, "Pro 5x");
  assert.deepEqual(
    result.windows.map((w) => [
      w.id,
      w.usedPercent,
      w.periodSeconds,
      w.resetsAt,
    ]),
    [
      ["weekly", 24, WEEK_S, NOW + 150 * HOUR],
      ["spark", 5, 18_000, 1_790_600_000_000],
    ],
  );
  assert.equal(requests[0]!.headers.Authorization, `Bearer ${token}`);
  assert.equal(requests[0]!.headers["ChatGPT-Account-Id"], "acct-1");
  const row = paceRow({
    providerId: "codex",
    plan: result.plan,
    windows: result.windows,
    refreshedAt: NOW,
    now: NOW,
  });
  assert.equal(row.windowId, "weekly");
  assert.equal(row.shortWindowId, "spark", "没有 session 时取 6 小时内最短");
});

test("Codex：窗口分类、请求头兜底与套餐名", () => {
  const headers = new Headers({
    "x-codex-primary-used-percent": "31",
    "x-codex-secondary-used-percent": "9",
  });
  assert.deepEqual(
    mapCodexUsage({ rate_limit: {} }, headers, NOW)!.map((w) => [
      w.id,
      w.usedPercent,
      w.periodSeconds,
      w.resetsAt,
    ]),
    [
      ["session", 31, 18_000, null],
      ["weekly", 9, WEEK_S, null],
    ],
  );
  const normal = mapCodexUsage(
    {
      rate_limit: {
        primary_window: { used_percent: 40, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: "12", limit_window_seconds: WEEK_S },
      },
    },
    new Headers(),
    NOW,
  )!;
  assert.deepEqual(
    normal.map((w) => [w.id, w.usedPercent]),
    [
      ["session", 40],
      ["weekly", 12],
    ],
  );
  assert.deepEqual(mapCodexUsage({}, new Headers(), NOW), []);
  assert.equal(mapCodexUsage("x", new Headers(), NOW), undefined);
  assert.equal(codexPlan("pro"), "Pro 20x");
  assert.equal(codexPlan("plus"), "Plus");
  assert.equal(codexPlan("team_enterprise"), "Team Enterprise");
  assert.equal(codexPlan(""), null);
  assert.equal(codexPlan(3), null);
});

test("Codex：缺失、只有 API key、过期、接口报错与结构变了", async () => {
  const path = "/home/u/.codex/auth.json";
  const read = (
    files: Record<string, string>,
    reply?: Reply | "timeout" | "network",
  ) => {
    const fake = fakeDeps({
      files,
      replies: reply ? { [CODEX_USAGE_URL]: reply } : {},
    });
    return readCodex(fake.deps).then((result) => ({ result, fake }));
  };
  assert.deepEqual((await read({})).result, {
    ok: false,
    reason: "没有找到 Codex 登录，运行 codex 用 ChatGPT 账号登录",
  });
  assert.deepEqual(
    (await read({ [path]: JSON.stringify({ OPENAI_API_KEY: "sk-SECRET" }) }))
      .result,
    {
      ok: false,
      reason: "Codex 只用 API key 登录，没有订阅额度；改用 ChatGPT 账号登录",
    },
  );
  assert.deepEqual((await read({ [path]: "{" })).result, {
    ok: false,
    reason: "Codex 登录数据读不出，运行 codex 重新登录",
  });
  const expired = await read({ [path]: codexAuth(jwt(NOW - 1000)) });
  assert.match(
    (expired.result as { reason: string }).reason,
    /^Codex 登录已过期（\/home\/u\/\.codex\/auth\.json），运行一次 codex 会自动续期$/,
  );
  assert.equal(expired.fake.requests.length, 0, "过期不发请求，也不替它刷新");
  // 不是 JWT 的令牌不判过期，交给接口判。
  const fresh = { [path]: codexAuth(`opaque-${SECRET}`) };
  const cases: [Reply | "timeout" | "network", string][] = [
    [
      { status: 403 },
      "Codex 用量接口拒绝了登录（令牌失效），运行 codex 重新登录",
    ],
    [{ status: 502, body: SECRET }, "Codex 用量接口返回 HTTP 502"],
    ["timeout", "Codex 用量接口超时"],
    ["network", "连不上 Codex 用量接口"],
    [{ status: 200, body: [SECRET] }, "Codex 用量接口返回的结构认不出"],
    [
      { status: 200, body: { plan_type: "plus" } },
      "Codex 用量接口返回的结构认不出",
    ],
  ];
  for (const [reply, reason] of cases) {
    const { result } = await read(fresh, reply);
    assert.deepEqual(result, { ok: false, reason });
    noLeak(result);
  }
  // 前一个候选读不出、后一个可用：用后一个。
  const second = await read(
    {
      "/home/u/.config/codex/auth.json": "garbage",
      [path]: codexAuth(jwt(NOW + HOUR)),
    },
    { status: 200, body: CODEX_USAGE },
  );
  assert.equal(second.result.ok, true);
});

// —— OpenCode ——

const OPENCODE_AUTH = JSON.stringify({
  "zai-coding-plan": { type: "api", key: "SECRET-zai" },
  "opencode-go": { type: "api", key: `  ${SECRET}  ` },
});

const OPENCODE_USAGE = {
  usage: {
    rolling: { percent: 0, resetsAt: "2026-09-27T15:00:00Z", status: "ok" },
    weekly: { percent: 23, resetsAt: "2026-09-28T00:00:00Z", status: "ok" },
    monthly: { percent: 72, resetsAt: "2026-10-05T00:00:00Z", status: "ok" },
  },
};

test("OpenCode：读数据目录 auth.json 的 opencode-go key，折成会话 / 周 / 月窗口", async () => {
  const { deps, requests } = fakeDeps({
    platform: "darwin",
    home: "/Users/u",
    files: { "/Users/u/.local/share/opencode/auth.json": OPENCODE_AUTH },
    replies: { [OPENCODE_USAGE_URL]: { status: 200, body: OPENCODE_USAGE } },
  });
  const result = (await readOpencode(deps)) as ReadOk;
  assert.equal(result.ok, true);
  assert.equal(result.plan, "Go");
  assert.deepEqual(
    result.windows.map((w) => [w.id, w.usedPercent, w.periodSeconds]),
    [
      ["session", 0, 18_000],
      ["weekly", 23, WEEK_S],
      ["monthly", 72, 0],
    ],
  );
  assert.equal(requests[0]!.headers.Authorization, `Bearer ${SECRET}`);
  const row = paceRow({
    providerId: "opencode",
    plan: "Go",
    windows: result.windows,
    refreshedAt: NOW,
    now: NOW,
  });
  assert.deepEqual(
    [row.windowId, row.usedPercent, row.hoursToReset, row.shortWindowId],
    ["weekly", 23, 13, "session"],
  );
});

test("OpenCode：没登录 Go、缺失、读不出、没有订阅、接口报错与结构变了", async () => {
  const path = "/home/u/.local/share/opencode/auth.json";
  const read = (files: Record<string, string>, reply?: Reply | "timeout") =>
    readOpencode(
      fakeDeps({
        files,
        replies: reply ? { [OPENCODE_USAGE_URL]: reply } : {},
      }).deps,
    );
  assert.deepEqual(await read({}), {
    ok: false,
    reason: "没有找到 OpenCode 登录，登录 OpenCode Go",
  });
  assert.deepEqual(await read({ [path]: '{"openai":{"type":"oauth"}}' }), {
    ok: false,
    reason: "OpenCode 没有登录 OpenCode Go",
  });
  assert.deepEqual(await read({ [path]: "[]" }), {
    ok: false,
    reason: "OpenCode 登录数据读不出，重新登录 OpenCode Go",
  });
  const cases: [Reply | "timeout", string][] = [
    [{ status: 401 }, "OpenCode Go 登录失效或过期，重新登录 OpenCode Go"],
    [
      {
        status: 403,
        body: { error: { type: "EntitlementError", message: SECRET } },
      },
      "没有 OpenCode Go 订阅",
    ],
    [
      { status: 403, body: { error: { type: "Other" } } },
      "OpenCode Go 用量接口返回 HTTP 403",
    ],
    [{ status: 429 }, "OpenCode Go 用量接口返回 HTTP 429"],
    ["timeout", "OpenCode Go 用量接口超时"],
    [
      { status: 200, body: { usage: {} } },
      "OpenCode Go 用量接口返回的结构认不出",
    ],
    [
      {
        status: 200,
        body: { usage: { ...OPENCODE_USAGE.usage, weekly: { percent: "x" } } },
      },
      "OpenCode Go 用量接口返回的结构认不出",
    ],
  ];
  for (const [reply, reason] of cases) {
    const result = await read({ [path]: OPENCODE_AUTH }, reply);
    assert.deepEqual(result, { ok: false, reason });
    noLeak(result);
  }
  assert.equal(
    mapOpencodeUsage({
      usage: {
        rolling: { percent: 140 },
        weekly: { percent: -3 },
        monthly: { percent: 1 },
      },
    })!
      .map((w) => w.usedPercent)
      .join(","),
    "100,0,1",
  );
});

// —— 缓存与节流 ——

function countingReader(
  provider: string,
  results: ReadResult[],
): Reader & { calls: number } {
  const reader = {
    provider,
    calls: 0,
    async read() {
      const result = results[Math.min(reader.calls, results.length - 1)]!;
      reader.calls++;
      return result;
    },
  };
  return reader;
}

const good = (at: number, used = 10): ReadOk => ({
  ok: true,
  plan: null,
  windows: [weekly({ usedPercent: used })],
  refreshedAt: at,
});

test("缓存：成功 5 分钟内不再请求，失败 1 分钟后重试，限流按 Retry-After 推迟", async () => {
  let now = NOW;
  const { deps } = fakeDeps({ now: () => now });
  const reader = countingReader("claude", [
    good(NOW),
    {
      ok: false,
      reason: "Claude 用量接口限流",
      retryAt: NOW + OK_TTL_MS + 10 * 60_000,
    },
    good(NOW + 20 * 60_000, 30),
  ]);
  const readers = new QuotaReaders(deps, [reader]);
  const first = await readers.read();
  assert.equal(reader.calls, 1);
  assert.equal(first.get("claude")!.ok, true);
  now += OK_TTL_MS - 1;
  await readers.read();
  assert.equal(reader.calls, 1, "成功读数 5 分钟内复用");
  now = NOW + OK_TTL_MS;
  const limited = (await readers.read()).get("claude")!;
  assert.equal(reader.calls, 2);
  assert.deepEqual(limited, {
    ok: true,
    result: good(NOW),
    note: "本次读不到（Claude 用量接口限流），沿用上次读数",
  });
  now = NOW + OK_TTL_MS + FAILED_TTL_MS;
  await readers.read();
  assert.equal(reader.calls, 2, "限流期内不再请求");
  now = NOW + OK_TTL_MS + 10 * 60_000;
  const back = (await readers.read()).get("claude")!;
  assert.equal(reader.calls, 3);
  assert.equal(back.ok && back.note, null);
});

test("缓存：同一账号并发只发一个请求；读取器抛错不外传原文", async () => {
  const { deps } = fakeDeps();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const slow: Reader = {
    provider: "codex",
    async read() {
      calls++;
      await gate;
      return good(NOW);
    },
  };
  const boom: Reader = {
    provider: "opencode",
    async read() {
      throw new Error(`boom ${SECRET}`);
    },
  };
  const readers = new QuotaReaders(deps, [slow, boom]);
  const both = Promise.all([readers.read(), readers.read()]);
  release();
  const [a, b] = await both;
  assert.equal(calls, 1);
  assert.equal(a.get("codex")!.ok, true);
  assert.deepEqual(b.get("opencode"), {
    ok: false,
    reason: "读取 opencode 额度时出错",
  });
  noLeak([...b.values()]);
});

test("沿用上次读数：6 小时内沿用并注明，更早的不沿用", () => {
  const failed: ReadResult = { ok: false, reason: "连不上 Claude 用量接口" };
  assert.deepEqual(outcomeOf(failed, undefined, NOW), {
    ok: false,
    reason: "连不上 Claude 用量接口",
  });
  assert.equal(outcomeOf(failed, good(NOW - LAST_GOOD_MS + 1), NOW).ok, true);
  assert.equal(outcomeOf(failed, good(NOW - LAST_GOOD_MS), NOW).ok, false);
  assert.deepEqual(outcomeOf(good(NOW), undefined, NOW), {
    ok: true,
    result: good(NOW),
    note: null,
  });
});

test("自带读取开关：ATRIUM_QUOTA_READERS=off 或 node:test 进程里关", () => {
  assert.equal(readersEnabled({}), true);
  assert.equal(readersEnabled({ ATRIUM_QUOTA_READERS: "off" }), false);
  assert.equal(readersEnabled({ ATRIUM_QUOTA_READERS: "0" }), false);
  assert.equal(readersEnabled({ ATRIUM_QUOTA_READERS: "on" }), true);
  assert.equal(readersEnabled({ NODE_TEST_CONTEXT: "child-v8" }), false);
  assert.equal(readersEnabled(process.env), false, "本测试进程不读本机凭据");
});

// —— 来源合并 ——

test("合并：自带优先，自带读不到时 OpenQuota 补并注明，两边都没有标读不到或没有额度数据", () => {
  const builtin = new Map<string, ReaderOutcome>([
    ["claude", { ok: true, result: good(NOW, 20), note: null }],
    ["codex", { ok: false, reason: "Codex 用量接口超时" }],
    [
      "opencode",
      { ok: false, reason: "没有找到 OpenCode 登录，登录 OpenCode Go" },
    ],
  ]);
  const rows = mergeQuotaRows({
    builtin,
    openquota: [
      { providerId: "claude", usedPercent: 99, refreshedAt: "x" },
      { providerId: "codex", usedPercent: 24, refreshedAt: "y" },
      { providerId: "cursor", usedPercent: 49.6, refreshedAt: "z" },
      { providerId: "cursor", usedPercent: 1 },
      { usedPercent: 1 },
      "junk",
    ],
    expected: ["claude", "codex", "kimi", "opencode"],
    now: NOW,
  });
  assert.deepEqual(
    rows.map((row) => [row.providerId, row.source, row.usedPercent, row.note]),
    [
      ["claude", "builtin", 20, null],
      ["codex", "openquota", 24, "自带读不到：Codex 用量接口超时"],
      [
        "opencode",
        "builtin",
        undefined,
        "读不到：没有找到 OpenCode 登录，登录 OpenCode Go",
      ],
      ["cursor", "openquota", 49.6, null],
      ["kimi", null, undefined, "没有额度数据"],
    ],
  );
  assert.deepEqual(
    rows.filter(hasQuotaData).map((row) => row.providerId),
    ["claude", "codex", "cursor"],
  );
  assert.deepEqual(
    mergeQuotaRows({
      builtin: new Map(),
      openquota: undefined,
      expected: ["claude", "claude"],
      now: NOW,
    }),
    [{ providerId: "claude", source: null, note: "没有额度数据" }],
  );
});

test("旧数：自带读取器与 OpenQuota 的旧行一视同仁，带上 stale 与多久前，都不算富余", () => {
  const rows = mergeQuotaRows({
    builtin: new Map<string, ReaderOutcome>([
      ["claude", { ok: true, result: good(NOW - 20 * 60_000), note: null }],
      ["codex", { ok: true, result: good(NOW - 60_000), note: null }],
    ]),
    openquota: [
      {
        providerId: "cursor",
        usedPercent: 10,
        sparePercent: 50,
        refreshedAt: "2026-09-27T08:30:00Z",
        refreshedHoursAgo: 2.5,
        stale: true,
      },
      {
        providerId: "kimi",
        usedPercent: 10,
        sparePercent: 30,
        refreshedAt: "2026-09-27T10:58:00Z",
        refreshedHoursAgo: 0,
        stale: false,
      },
    ],
    now: NOW,
  });
  const pace = parsePace(JSON.stringify(rows))!;
  const claude = pace.find((entry) => entry.providerId === "claude")!;
  assert.equal(typeof claude.sparePercent, "number", "旧数仍带着读数");
  assert.equal(claude.stale, true);
  assert.equal(claude.refreshedHoursAgo, 0.3);
  const cursor = pace.find((entry) => entry.providerId === "cursor")!;
  assert.deepEqual([cursor.stale, cursor.refreshedHoursAgo], [true, 2.5]);
  assert.equal(
    pace.find((entry) => entry.providerId === "codex")!.stale,
    undefined,
  );
  assert.deepEqual(
    [...spareByProvider(pace).keys()].sort(),
    ["codex", "kimi"],
    "旧数不进富余，不拿它往后推算",
  );
});

// —— 接入：atrium quota 与挑执行者 ——

function fakeReaders() {
  const { deps } = fakeDeps({
    files: {
      "/home/u/.claude/.credentials.json": CLAUDE_LOGIN,
      "/home/u/.codex/auth.json": codexAuth(jwt(NOW + HOUR)),
    },
    replies: {
      [CLAUDE_USAGE_URL]: { status: 200, body: CLAUDE_USAGE },
      [CODEX_USAGE_URL]: { status: 500 },
    },
  });
  return new QuotaReaders(deps);
}

function fakeOpenquota(dir: string, rows: unknown[]) {
  return writeFakeBin(
    join(dir, "openquota"),
    `#!/bin/sh\necho '${JSON.stringify(rows).replace(/'/g, "")}'\n`,
  );
}

test("atrium quota：没有 OpenQuota 时三家读取器给数据或读不到原因，每行标来源", async () => {
  const result = await listQuota({
    bin: "/nonexistent/openquota",
    readers: fakeReaders(),
    now: NOW,
  });
  assert.deepEqual(result.notes, []);
  assert.deepEqual(
    result.accounts.map((row) => [row.providerId, row.source, row.note]),
    [
      ["claude", "builtin", null],
      ["antigravity", null, "没有额度数据"],
      ["codex", "builtin", "读不到：Codex 用量接口返回 HTTP 500"],
      ["cursor", null, "没有额度数据"],
      ["grok", null, "没有额度数据"],
      ["kimi", null, "没有额度数据"],
      [
        "opencode",
        "builtin",
        "读不到：没有找到 OpenCode 登录，登录 OpenCode Go",
      ],
    ],
  );
  const claude = result.accounts[0]!;
  assert.equal(claude.plan, "Max 5x");
  assert.equal(claude.usedPercent, 20);
  assert.equal(claude.shortWindowUsedPercent, 3);
  noLeak(result);
});

test("atrium quota 与 readPace：自带没覆盖的账号由 OpenQuota 补，读不到的不进挑执行者", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-quota-readers-"));
  t.after(() => removeTemp(dir));
  const bin = fakeOpenquota(dir, [
    {
      providerId: "kimi",
      usedPercent: 60,
      sparePercent: -28.8,
      refreshedAt: "2026-09-27T10:58:22Z",
    },
    {
      providerId: "codex",
      usedPercent: 24,
      sparePercent: -13.6,
      refreshedAt: "2026-09-27T10:58:21Z",
    },
  ]);
  const readers = fakeReaders();
  const listed = await listQuota({ bin, readers, now: NOW });
  const byId = new Map(listed.accounts.map((row) => [row.providerId, row]));
  assert.equal(byId.get("kimi")!.source, "openquota");
  assert.equal(byId.get("codex")!.source, "openquota");
  assert.equal(
    byId.get("codex")!.note,
    "自带读不到：Codex 用量接口返回 HTTP 500",
  );
  assert.equal(byId.get("claude")!.source, "builtin");
  assert.equal(byId.get("grok")!.note, "没有额度数据");

  const pace = await readPace(bin, 10_000, { readers });
  assert.deepEqual(
    pace?.map((entry) => [entry.providerId, entry.usedPercent]),
    [
      ["claude", 20],
      ["codex", 24],
      ["kimi", 60],
    ],
  );
  assert.equal(
    await readPace("/nonexistent/openquota", 10_000, { readers: null }),
    undefined,
    "一个有数据的账号都没有时退回档案顺序",
  );

  const { app } = await createApp({
    data: join(dir, "data"),
    auth: false,
    quotaBin: bin,
    quotaReaders: readers,
  });
  try {
    const reply = await app.inject({
      url: "/api/quota",
      headers: { host: "127.0.0.1" },
    });
    assert.equal(reply.statusCode, 200);
    const body = reply.json() as QuotaList;
    assert.equal(
      body.accounts.find((row) => row.providerId === "claude")!.source,
      "builtin",
    );
    noLeak(body);
  } finally {
    await app.close();
  }
});
