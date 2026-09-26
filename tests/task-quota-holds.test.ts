/**
 * 额度标记与避让（#267 2）的纯判定：到期时刻与兜底、原因文本、哪些账号还被标记、收尾去向、
 * pickWorker 跳过被标记的账号、退出收尾判受阻；另用内存库验证标记的去重与解除。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TOOLS } from "../server/tasks/adapters/index.ts";
import { decideExit } from "../server/tasks/outcome.ts";
import { pickWorker } from "../server/tasks/prepare.ts";
import {
  clock,
  DEFAULT_UNKNOWN_HOLD_MS,
  ensureQuotaHoldTable,
  expiredHolds,
  heldProviders,
  holdUntil,
  listHolds,
  placeHold,
  quotaReason,
  releaseHold,
  routeAfterQuota,
  type QuotaHold,
} from "../server/tasks/quota-holds.ts";

const NOW = Date.UTC(2026, 8, 27, 8, 0);
const HOUR = 3_600_000;

test("到期时刻：有恢复时间用它；恢复时间未知默认 now + 1 小时，可配置", () => {
  assert.equal(holdUntil(new Date(NOW + 90 * 60_000), NOW), NOW + 90 * 60_000);
  assert.equal(DEFAULT_UNKNOWN_HOLD_MS, HOUR);
  assert.equal(holdUntil(null, NOW), NOW + HOUR);
  assert.equal(holdUntil(null, NOW, 5 * 60_000), NOW + 5 * 60_000);
  assert.equal(holdUntil(new Date(NaN), NOW), NOW + HOUR);
});

test("受阻原因：写明 provider 与预计恢复时刻，或恢复时间未知", () => {
  const at = new Date(NOW + 2 * HOUR);
  assert.equal(
    quotaReason("codex", at),
    `额度用尽：codex，预计 ${clock(at.getTime())} 恢复`,
  );
  assert.match(clock(at.getTime()), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(quotaReason("claude", null), "额度用尽：claude，恢复时间未知");
});

test("标记是否生效：未到期的避开，到期的解除；until 为空按 since + 兜底时长", () => {
  const holds: QuotaHold[] = [
    { provider: "codex", until: NOW + 1, reason: null, since: NOW - HOUR },
    { provider: "claude", until: NOW, reason: null, since: NOW - HOUR },
    { provider: "kimi", until: null, reason: null, since: NOW - 10 * 60_000 },
    { provider: "grok", until: null, reason: null, since: NOW - 2 * HOUR },
  ];
  assert.deepEqual(
    [...heldProviders(holds, NOW)],
    [
      ["codex", NOW + 1],
      ["kimi", NOW + 50 * 60_000],
    ],
  );
  assert.deepEqual(
    expiredHolds(holds, NOW).map((hold) => hold.provider),
    ["claude", "grok"],
  );
  // 兜底时长可配置：kimi 标记 5 分钟就过期。
  assert.deepEqual(
    expiredHolds(holds, NOW, 5 * 60_000).map((hold) => hold.provider),
    ["claude", "kimi", "grok"],
  );
});

test("收尾去向穷举：档案允许 × 是否换过", () => {
  const cases: [boolean, boolean, string][] = [
    [true, false, "switch"],
    [true, true, "blocked"],
    [false, false, "blocked"],
    [false, true, "blocked"],
  ];
  for (const [switchAllowed, switched, kind] of cases)
    assert.equal(
      routeAfterQuota({ switchAllowed, switched }).kind,
      kind,
      `${switchAllowed}/${switched}`,
    );
  assert.match(
    JSON.stringify(routeAfterQuota({ switchAllowed: true, switched: true })),
    /已因额度换过一次/,
  );
});

test("pickWorker：跳过额度标记未到期的账号；全部被标记报不可用", () => {
  const held = new Map([["codex", NOW + HOUR]]);
  const picked = pickWorker({
    installed: ["codex", "opencode"],
    risk: "low",
    profiles: {},
    held,
  });
  assert.ok(picked.ok);
  assert.equal(picked.tool, "opencode");
  assert.deepEqual(
    picked.skipped.find((skip) => skip.tool === "codex"),
    {
      tool: "codex",
      reason: `额度用尽至 ${clock(NOW + HOUR)}`,
    },
  );
  const none = pickWorker({
    installed: [...TOOLS],
    risk: "low",
    profiles: {},
    held: new Map(TOOLS.map((tool) => [tool, NOW + HOUR])),
  });
  assert.equal(none.ok, false);
  assert.match(!none.ok ? none.reason : "", /额度用尽/);
});

test("退出收尾：额度用尽直接受阻、不重试；被人工停下的仍按停止处理", () => {
  const reason = "额度用尽：codex，恢复时间未知";
  assert.deepEqual(
    decideExit({
      exit: { code: 1, signal: null },
      retried: false,
      retryAllowed: true,
      quota: reason,
    }),
    { event: "block", publish: "blocked", reason, retry: false },
  );
  assert.equal(
    decideExit({
      stop: { kind: "user" },
      exit: { code: 1, signal: null },
      retried: false,
      retryAllowed: true,
      quota: reason,
    }).publish,
    "failed",
  );
});

test("落库：同一账号未到期时不算新标记、只往后推；到期后新记；解除只删到期的", () => {
  const db = new DatabaseSync(":memory:");
  ensureQuotaHoldTable(db);
  const put = (until: number, now: number) =>
    placeHold(db, { provider: "codex", until, reason: "r" }, now);
  assert.deepEqual(put(NOW + HOUR, NOW), { fresh: true, until: NOW + HOUR });
  assert.deepEqual(put(NOW + 10, NOW + 5), { fresh: false, until: NOW + HOUR });
  assert.deepEqual(put(NOW + 2 * HOUR, NOW + 5), {
    fresh: false,
    until: NOW + 2 * HOUR,
  });
  assert.equal(listHolds(db)[0]!.since, NOW);
  assert.equal(releaseHold(db, "codex", NOW + HOUR), false, "还没到期不删");
  assert.equal(releaseHold(db, "codex", NOW + 2 * HOUR), true);
  assert.deepEqual(listHolds(db), []);
  assert.deepEqual(put(NOW + 3 * HOUR, NOW + 2 * HOUR), {
    fresh: true,
    until: NOW + 3 * HOUR,
  });
  // 破坏输入：provider 里的引号按参数处理，不拼进 SQL。
  placeHold(
    db,
    { provider: "x'); DROP TABLE quota_holds;--", until: NOW, reason: "r" },
    NOW,
  );
  assert.equal(listHolds(db).length, 2);
  db.close();
});
