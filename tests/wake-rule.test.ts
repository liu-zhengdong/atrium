import { test } from "node:test";
import assert from "node:assert/strict";
import { decideWake, nextWakeCount } from "../server/tasks/wake-rule.ts";

test("唤醒规则：攒批、会话可用、当前一轮、连续上限的所有组合", () => {
  const now = 10_000;
  for (const hasEvents of [false, true])
    for (const batchReady of [false, true])
      for (const sessionReady of [false, true])
        for (const turnRunning of [false, true])
          for (const atLimit of [false, true]) {
            const decision = decideWake({
              events: hasEvents
                ? [{ id: 2, queuedAt: batchReady ? 8_000 : 9_001 }]
                : [],
              now,
              batchMs: 1000,
              sessionReady,
              turnRunning,
              consecutiveWakeups: atLimit ? 3 : 2,
              maxConsecutiveWakeups: 3,
            });
            const expected = !hasEvents
              ? "empty"
              : !batchReady
                ? "batching"
                : !sessionReady
                  ? "unavailable"
                  : turnRunning
                    ? "busy"
                    : atLimit
                      ? "limit"
                      : "send";
            assert.equal(
              decision.kind,
              expected,
              JSON.stringify({
                hasEvents,
                batchReady,
                sessionReady,
                turnRunning,
                atLimit,
              }),
            );
          }
});

test("攒批以最早事件为准，忙时保留整批；成功才计次数，用户新一轮重置", () => {
  const base = {
    now: 10_000,
    batchMs: 1000,
    sessionReady: true,
    turnRunning: false,
    consecutiveWakeups: 0,
    maxConsecutiveWakeups: 2,
  };
  const events = [
    { id: 5, queuedAt: 9_000 },
    { id: 3, queuedAt: 9_950 },
    { id: 5, queuedAt: 9_999 },
  ];
  assert.deepEqual(decideWake({ ...base, events }), {
    kind: "send",
    eventIds: [3, 5],
  });
  assert.deepEqual(decideWake({ ...base, events, turnRunning: true }), {
    kind: "busy",
  });
  assert.deepEqual(
    decideWake({ ...base, events: [{ id: 1, queuedAt: 9_001 }] }),
    { kind: "batching", readyAt: 10_001 },
  );
  assert.equal(nextWakeCount(1, "failed"), 1);
  assert.equal(nextWakeCount(1, "delivered"), 2);
  assert.deepEqual(decideWake({ ...base, events, consecutiveWakeups: 2 }), {
    kind: "limit",
  });
  assert.equal(nextWakeCount(2, "user_turn"), 0);
  assert.equal(
    decideWake({ ...base, events, consecutiveWakeups: 0 }).kind,
    "send",
  );
});
