import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  NO_SESSION,
  UNATTENDED_MS,
  WAKE_FAILED,
  secretaryText,
  secretaryView,
  watchDecision,
  type SecretaryView,
  type WatchInput,
} from "../server/tasks/secretary-watch.ts";
import { EventInbox } from "../server/tasks/events.ts";
import { createApp } from "../server/app.ts";
import { ensureTaskTables } from "../server/tasks/ledger.ts";
import {
  SecretaryFallback,
  type SecretaryAlert,
} from "../server/tasks/secretary-fallback.ts";
import { saveSecretarySession } from "../server/tasks/secretary-session.ts";
import { renderStatusline } from "../cli/statusline.ts";
import { awayPush, messageText } from "../server/notify/model.ts";
import { removeTemp } from "./temp-dir.ts";

const MIN = 60_000;
const base: WatchInput = {
  now: 100 * MIN,
  presence: { waiting: false, last_seen: 90 * MIN },
  oldest: 95 * MIN,
  graceMs: UNATTENDED_MS,
  session: true,
  limit: false,
  retryAt: null,
};

test("判定：没有要处理的事件、有人在听都不叫醒", () => {
  assert.deepEqual(watchDecision({ ...base, oldest: null }), {
    kind: "quiet",
  });
  assert.deepEqual(
    watchDecision({
      ...base,
      oldest: null,
      presence: { waiting: true, last_seen: 0 },
    }),
    { kind: "quiet" },
  );
  assert.deepEqual(
    watchDecision({ ...base, presence: { waiting: true, last_seen: 0 } }),
    { kind: "listening" },
  );
});

test("判定：从最后一次在听与最早一条事件较晚的那刻起满 3 分钟才叫醒", () => {
  // 事件晚于最后一次在听：从事件算。
  assert.deepEqual(watchDecision({ ...base, now: 97 * MIN }), {
    kind: "wait",
    at: 98 * MIN,
  });
  assert.deepEqual(watchDecision({ ...base, now: 98 * MIN }), {
    kind: "wake",
  });
  // 刚刚还在听（事件早就在，比如租约到期重投）：从在听算。
  assert.deepEqual(
    watchDecision({
      ...base,
      presence: { waiting: false, last_seen: 99 * MIN },
      oldest: 10 * MIN,
    }),
    { kind: "wait", at: 102 * MIN },
  );
  // 服务刚起来还没人来过：last_seen 是服务起来的时刻。
  assert.deepEqual(
    watchDecision({
      ...base,
      presence: { waiting: false, last_seen: 100 * MIN },
      oldest: 0,
    }),
    { kind: "wait", at: 103 * MIN },
  );
});

test("判定：叫不起来的三种原因；到期前不判叫不起来", () => {
  assert.deepEqual(watchDecision({ ...base, session: false }), {
    kind: "unreachable",
    reason: NO_SESSION,
  });
  assert.equal(
    watchDecision({ ...base, session: false, now: 96 * MIN }).kind,
    "wait",
  );
  const limit = watchDecision({ ...base, limit: true });
  assert.equal(limit.kind, "unreachable");
  assert.match((limit as { reason: string }).reason, /连续叫醒/);
  // 没会话优先于上限说。
  assert.deepEqual(watchDecision({ ...base, session: false, limit: true }), {
    kind: "unreachable",
    reason: NO_SESSION,
  });
  assert.deepEqual(watchDecision({ ...base, retryAt: 101 * MIN }), {
    kind: "unreachable",
    reason: WAKE_FAILED,
  });
  assert.deepEqual(watchDecision({ ...base, retryAt: 100 * MIN }), {
    kind: "wake",
  });
});

const view = (extra: Partial<SecretaryView> = {}): SecretaryView => ({
  listening: false,
  away_ms: 12 * MIN,
  pending: 3,
  waking: false,
  overdue: true,
  unreachable: null,
  ...extra,
});

test("显示：在听、后台处理中、没在听（没事／有事没到点／没人管／叫不起来）", () => {
  assert.deepEqual(
    secretaryText(view({ listening: true, away_ms: null, pending: 0 })),
    { text: "秘书在听", tone: "ok" },
  );
  assert.deepEqual(
    secretaryText(view({ listening: true, away_ms: null, pending: 1 })),
    { text: "秘书在听 · 未处理 1", tone: "ok" },
  );
  assert.deepEqual(secretaryText(view({ waking: true })), {
    text: "秘书后台处理中 · 未处理 3",
    tone: "ok",
  });
  assert.deepEqual(secretaryText(view({ pending: 0, overdue: false })), {
    text: "秘书没在听 12 分钟",
    tone: "ok",
  });
  assert.deepEqual(secretaryText(view({ away_ms: 30_000, overdue: false })), {
    text: "秘书没在听 · 未处理 3",
    tone: "warn",
  });
  assert.deepEqual(secretaryText(view()), {
    text: "秘书没在听 12 分钟 · 未处理 3",
    tone: "alarm",
  });
  assert.deepEqual(secretaryText(view({ unreachable: NO_SESSION })), {
    text: `秘书没在听 12 分钟 · 未处理 3 · 叫不起来：${NO_SESSION}`,
    tone: "alarm",
  });
});

test("显示用的状态：没在听多久、是否已满时限", () => {
  const input = {
    now: 100 * MIN,
    presence: { waiting: false, last_seen: 90 * MIN },
    pending: 2,
    oldest: 98 * MIN,
    graceMs: UNATTENDED_MS,
    waking: false,
    unreachable: null,
  };
  assert.deepEqual(secretaryView(input), {
    listening: false,
    away_ms: 10 * MIN,
    pending: 2,
    waking: false,
    overdue: false,
    unreachable: null,
  });
  assert.equal(secretaryView({ ...input, oldest: 97 * MIN }).overdue, true);
  assert.equal(
    secretaryView({ ...input, pending: 0, oldest: null }).overdue,
    false,
  );
  const listening = secretaryView({
    ...input,
    presence: { waiting: true, last_seen: 0 },
    oldest: 0,
  });
  assert.equal(listening.away_ms, null);
  assert.equal(listening.overdue, false);
});

test("收件箱记谁此刻挂着 wait；唤醒通道自己的 peek 不算；重启后从服务起来算", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  let clock = 1000;
  const inbox = new EventInbox(db, { now: () => clock });
  try {
    assert.deepEqual(inbox.presence("secretary"), {
      waiting: false,
      last_seen: 1000,
    });
    clock = 2000;
    const abort = new AbortController();
    const waiting = inbox.wait("secretary", 60, abort.signal);
    assert.deepEqual(inbox.presence("secretary"), {
      waiting: true,
      last_seen: 2000,
    });
    const second = new AbortController();
    const other = inbox.wait("secretary", 60, second.signal);
    clock = 3000;
    abort.abort();
    await waiting;
    assert.equal(inbox.presence("secretary").waiting, true, "还有一条挂着");
    second.abort();
    await other;
    assert.deepEqual(inbox.presence("secretary"), {
      waiting: false,
      last_seen: 3000,
    });
    const peek = new AbortController();
    const fallback = inbox.wait("secretary", 60, peek.signal, {
      peek: true,
      trackOnline: false,
    });
    clock = 4000;
    assert.deepEqual(inbox.presence("secretary"), {
      waiting: false,
      last_seen: 3000,
    });
    peek.abort();
    await fallback;
    assert.equal(inbox.presence("secretary").last_seen, 3000);
    // 服务关闭时挂着的也收尾。
    const closing = inbox.wait("a1", 60);
    assert.equal(inbox.presence("a1").waiting, true);
    inbox.close();
    assert.equal((await closing).restarting, true);
    assert.equal(inbox.presence("a1").waiting, false);
  } finally {
    db.close();
  }
});

async function until(check: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`等不到：${what}`);
    await delay(10);
  }
}

test("兜底：没有可接着的会话时不叫醒，推一次给用户并标叫不起来；有人来听就解除", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-watch-"));
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  const alerts: SecretaryAlert[] = [];
  let turns = 0;
  const fallback = new SecretaryFallback(inbox, data, {
    graceMs: 20,
    checkMs: 20,
    runTurn: async () => {
      turns++;
      return true;
    },
    alert: (alert) => alerts.push(alert),
  });
  try {
    fallback.start();
    inbox.publish({
      subscriber: "secretary",
      source: "runner",
      kind: "done",
      key: "t1:outcome",
    });
    inbox.publish({
      subscriber: "secretary",
      source: "runner",
      kind: "failed",
      key: "t2:outcome",
    });
    await until(() => alerts.length > 0, "推送叫不起来");
    assert.deepEqual(alerts, [
      { key: "secretary-away:1", pending: 2, reason: NO_SESSION },
    ]);
    assert.deepEqual(fallback.status(), {
      waking: false,
      unreachable: NO_SESSION,
    });
    assert.equal(turns, 0);
    assert.equal(inbox.countPending("secretary"), 2, "事件原样留着");
    // 秘书回来挂上 wait：取走事件，状态解除。
    const taken = await inbox.wait("secretary", 1);
    assert.equal(taken.events.length, 2);
    inbox.ack(taken.events.map((event) => event.id));
    await until(() => fallback.status().unreachable === null, "解除标红");
    assert.equal(alerts.length, 1, "同一段只推一次");
  } finally {
    await fallback.close();
    db.close();
    removeTemp(data);
  }
});

test("兜底：秘书挂着 wait 时不叫醒；只有知会事件也不叫醒", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-watch-busy-"));
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  let turns = 0;
  const fallback = new SecretaryFallback(inbox, data, {
    graceMs: 20,
    checkMs: 20,
    runTurn: async () => {
      turns++;
      return true;
    },
  });
  saveSecretarySession(data, {
    tool: "opencode",
    sessionId: "ses_abc",
    cwd: data,
  });
  try {
    fallback.start();
    inbox.publish({
      subscriber: "secretary",
      source: "runner",
      kind: "overdue",
      key: "t3:overdue",
      detail: { holder: "worker", step: "wake" },
    });
    await delay(150);
    assert.equal(turns, 0, "执行者到期是知会，不叫醒");
    assert.equal(inbox.countPending("secretary"), 0);
    // 秘书挂着 wait：事件被它取走，后台不插手。
    const listen = inbox.wait("secretary", 60);
    inbox.publish({
      subscriber: "secretary",
      source: "runner",
      kind: "done",
      key: "t1:outcome",
    });
    assert.equal((await listen).events.length, 1);
    await delay(150);
    assert.equal(turns, 0, "秘书在听，不叫醒");
    // 秘书处理完没再挂 wait：下一件事没人听，满时限后叫醒。
    inbox.publish({
      subscriber: "secretary",
      source: "runner",
      kind: "failed",
      key: "t2:outcome",
    });
    await until(() => turns === 1, "没人听满时限后叫醒");
  } finally {
    await fallback.close();
    db.close();
    removeTemp(data);
  }
});

test("兜底：后台跑失败推给用户，事件放回，到重试时刻再叫", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-watch-fail-"));
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const inbox = new EventInbox(db);
  const alerts: SecretaryAlert[] = [];
  let turns = 0;
  const fallback = new SecretaryFallback(inbox, data, {
    graceMs: 30,
    checkMs: 20,
    runTurn: async () => {
      turns++;
      return false;
    },
    alert: (alert) => alerts.push(alert),
  });
  saveSecretarySession(data, {
    tool: "opencode",
    sessionId: "ses_abc",
    cwd: data,
  });
  try {
    fallback.start();
    inbox.publish({
      subscriber: "secretary",
      source: "runner",
      kind: "done",
      key: "t1:outcome",
    });
    await until(() => turns >= 2, "失败后到时再试");
    assert.equal(inbox.countPending("secretary"), 1, "失败不记送达");
    assert.deepEqual(alerts, [
      { key: "secretary-away:1", pending: 1, reason: WAKE_FAILED },
    ]);
  } finally {
    await fallback.close();
    db.close();
    removeTemp(data);
  }
});

test("状态栏：秘书在听、没在听标黄、没人管或叫不起来标红；空闲也说秘书在不在听", () => {
  const snapshot = (secretary: SecretaryView, events = 0) => ({
    now: 0,
    recent_ms: 0,
    subscriber: "secretary",
    counts: {
      running: 0,
      queued: 0,
      blocked: 0,
      processing: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
      events,
    },
    rows: [],
    truncated: false,
    secretary,
  });
  const render = (secretary: SecretaryView, events = 0, color = false) =>
    renderStatusline({
      snapshot: snapshot(secretary, events),
      plan: null,
      now: 0,
      color,
    });
  assert.equal(
    render(view({ listening: true, away_ms: null, pending: 0 })),
    "Atrium 空闲 · 秘书在听",
  );
  assert.equal(
    render(view({ pending: 0, overdue: false })),
    "Atrium 空闲 · 秘书没在听 12 分钟",
  );
  assert.equal(
    render(view(), 3),
    "Atrium 在做 0 · 秘书没在听 12 分钟 · 未处理 3",
  );
  assert.match(
    render(view(), 3, true),
    /\x1b\[1m\x1b\[31m秘书没在听 12 分钟 · 未处理 3/,
  );
  assert.match(
    render(view({ overdue: false, away_ms: 60_000 }), 3, true),
    /\x1b\[33m秘书没在听 1 分钟 · 未处理 3/,
  );
});

test("推送：秘书没在听一条，不挂短号", () => {
  const push = awayPush({
    key: "secretary-away:7",
    pending: 3,
    reason: WAKE_FAILED,
  });
  assert.equal(push.kind, "away");
  assert.equal(
    messageText([push]),
    `Atrium：1 件事\n【秘书没在听】3 件要处理的事没人管，${WAKE_FAILED}`,
  );
  assert.equal(
    messageText([{ kind: "shipped", ref: "t9", title: "" }]),
    "Atrium：1 件事\n【里程碑上线】t9",
  );
});

test("top 接口给秘书在不在听：没人听、有人挂着 wait", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-watch-top-"));
  const { app, taskRunner } = await createApp({
    data,
    auth: false,
    quotaReaders: null,
    secretary: { graceMs: 60 * MIN },
  });
  try {
    taskRunner.inbox.publish({
      subscriber: "secretary",
      source: "runner",
      kind: "done",
      key: "t1:outcome",
    });
    const top = async (as?: string) =>
      (
        await app.inject({
          method: "GET",
          url: `/api/tasks/top${as ? `?as=${as}` : ""}`,
        })
      ).json();
    const away = await top();
    assert.equal(away.secretary.listening, false);
    assert.equal(away.secretary.pending, 1);
    assert.equal(away.secretary.overdue, false);
    assert.equal(away.secretary.unreachable, null);
    assert.equal(typeof away.secretary.away_ms, "number");
    assert.equal((await top("a1")).secretary, undefined, "看别人的收件箱不给");
    const taken = await taskRunner.inbox.wait("secretary", 0);
    taskRunner.inbox.ack(taken.events.map((event) => event.id));
    const abort = new AbortController();
    const waiting = taskRunner.inbox.wait("secretary", 60, abort.signal);
    const listening = await top();
    assert.deepEqual(
      {
        listening: listening.secretary.listening,
        away: listening.secretary.away_ms,
      },
      { listening: true, away: null },
    );
    abort.abort();
    await waiting;
  } finally {
    await app.close();
    removeTemp(data);
  }
});
