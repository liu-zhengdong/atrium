import { test } from "node:test";
import assert from "node:assert/strict";
import { judge, watchLimits } from "../server/tasks/watch/watchdog.ts";
import { countSteps, summarize } from "../server/tasks/logs/summary.ts";
import { workerEnvironment } from "../server/tasks/dispatch/worker-env.ts";

test("看门狗判定：启动无进展判卡死，运行中空闲判受阻；档案 limits 可收紧", () => {
  const limits = { startupMs: 180_000, idleMs: 1_200_000 };
  assert.equal(
    judge({ startedAt: 0, lastProgressAt: null }, limits, 179_999).kind,
    "ok",
  );
  const stalled = judge(
    { startedAt: 0, lastProgressAt: null },
    limits,
    180_000,
  );
  assert.equal(stalled.kind, "stalled");
  assert.match((stalled as { reason: string }).reason, /3 分钟没有任何进展/);
  assert.equal(
    judge({ startedAt: 0, lastProgressAt: 10 }, limits, 1_000_000).kind,
    "ok",
  );
  assert.equal(
    judge({ startedAt: 0, lastProgressAt: 10 }, limits, 1_200_010).kind,
    "idle",
  );
  assert.deepEqual(watchLimits({ startup_minutes: 1 }), {
    startupMs: 60_000,
    idleMs: 1_200_000,
  });
});

test("摘要：结构化日志 opencode 取文本、claude 取 result，普通日志取末尾", () => {
  const opencode = [
    '{"type":"step_start","part":{}}',
    '{"type":"text","part":{"text":"改好了，PR #3"}}',
    '{"type":"step_finish","part":{}}',
  ].join("\n");
  assert.equal(summarize(opencode, true), "改好了，PR #3");
  assert.equal(countSteps(opencode), 2);
  const claude = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"中间"}]}}',
    '{"type":"result","result":"最终汇报"}',
  ].join("\n");
  assert.equal(summarize(claude, true), "最终汇报");
  assert.equal(summarize("a\nb\n"), "a\nb");
  assert.equal(Buffer.byteLength(summarize("汉".repeat(5000))) <= 4096, true);
});

test("执行者环境白名单：去掉 HERDR_*、CLAUDECODE、CLAUDE_CODE_*、PI_*、ATRIUM_* 与凭据", () => {
  const env = workerEnvironment({
    PATH: "/bin",
    HOME: "/h",
    LC_ALL: "C",
    HTTPS_PROXY: "http://p",
    HERDR_PANE: "1",
    HERDR_ENV: "1",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    PI_SESSION_ID: "s",
    ATRIUM_DATA: "/d",
    ATRIUM_PORT: "4310",
    GH_TOKEN: "t",
    OPENAI_API_KEY: "k",
    NODE_TEST_CONTEXT: "child",
    SSH_AUTH_SOCK: "/s",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "ATRIUM_TEST_CONCURRENCY",
    "ATRIUM_WORKER",
    "GH_PROMPT_DISABLED",
    "GIT_PAGER",
    "HOME",
    "HTTPS_PROXY",
    "LC_ALL",
    "NO_COLOR",
    "PAGER",
    "PATH",
  ]);
});
