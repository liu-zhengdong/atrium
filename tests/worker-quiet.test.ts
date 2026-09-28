import { test } from "node:test";
import assert from "node:assert/strict";
import {
  workerQuiet,
  workerQuietReason,
  workerQuietText,
} from "../server/tasks/worker-quiet.ts";
import type { WatchLimits } from "../server/tasks/watchdog.ts";

const MIN = 60_000;
const limits: WatchLimits = { startupMs: 20 * MIN, idleMs: 20 * MIN };

test("workerQuiet：按进展时刻 × 安静时长 × 提醒过 × 在停 × 提醒线穷举", () => {
  const start = 1_000;
  for (const progressed of [false, true])
    for (const quiet of [0, 5 * MIN - 1, 5 * MIN, 19 * MIN, 25 * MIN])
      for (const warned of [false, true])
        for (const stopping of [false, true])
          for (const warnMs of [0, 5 * MIN, 20 * MIN, 30 * MIN]) {
            const last = progressed ? start + 7 * MIN : null;
            const since = last ?? start;
            const got = workerQuiet({
              state: { startedAt: start, lastProgressAt: last },
              limits,
              warnMs,
              warned,
              stopping,
              now: since + quiet,
            });
            const due =
              !warned &&
              !stopping &&
              warnMs > 0 &&
              warnMs < 20 * MIN &&
              quiet >= warnMs;
            assert.deepEqual(
              got,
              due
                ? { kind: "warn", quietMs: quiet, stallMs: 20 * MIN }
                : { kind: "ok" },
              `${progressed} ${quiet} ${warned} ${stopping} ${warnMs}`,
            );
          }
});

test("workerQuiet：还没有进展按启动时限比，有过进展按空闲时限比", () => {
  const mixed: WatchLimits = { startupMs: 4 * MIN, idleMs: 20 * MIN };
  // 启动时限 4 分钟早于 5 分钟提醒线：到点直接判卡死，不提醒。
  assert.deepEqual(
    workerQuiet({
      state: { startedAt: 0, lastProgressAt: null },
      limits: mixed,
      warnMs: 5 * MIN,
      warned: false,
      stopping: false,
      now: 6 * MIN,
    }),
    { kind: "ok" },
  );
  assert.deepEqual(
    workerQuiet({
      state: { startedAt: 0, lastProgressAt: MIN },
      limits: mixed,
      warnMs: 5 * MIN,
      warned: false,
      stopping: false,
      now: 6 * MIN,
    }),
    { kind: "warn", quietMs: 5 * MIN, stallMs: 20 * MIN },
  );
});

test("提醒的说法：状态栏一句带执行者，事件原因写到多久判卡死", () => {
  assert.equal(
    workerQuietText("claude/opus", 5 * MIN + 20_000),
    "claude/opus 5 分钟没进展",
  );
  assert.equal(workerQuietText(null, 30_000), "执行者 30 秒没进展");
  assert.equal(
    workerQuietReason(5 * MIN, 20 * MIN),
    "执行者 5 分钟没有进展（没有日志输出、没有工具调用、工作目录没变化）；到 20 分钟没进展会判卡死",
  );
});
