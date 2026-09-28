/**
 * 额度报文解析（#267 1）：每种真实样本一条，反例（认证、网络、测试失败）各一条不被误判，
 * 另加跨午夜与跨时区的时间解析。样本都在 tests/fixtures/quota/，每个文本文件一份日志末尾。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  detectQuotaExhausted,
  quotaErrorText,
  type QuotaVerdict,
} from "../server/tasks/quota/quota-signal.ts";

const sample = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/quota/${name}`, import.meta.url)),
    "utf8",
  );

/** 样本都是失败退出；只在要说明退出码规则的用例里改。 */
function detect(
  logTail: string,
  now: Date,
  options: { exitCode?: number | null; tool?: "codex" | "claude" } = {},
): QuotaVerdict {
  return detectQuotaExhausted({
    exitCode: options.exitCode === undefined ? 1 : options.exitCode,
    logTail,
    now,
    tool: options.tool ?? "codex",
  });
}

function hit(verdict: QuotaVerdict) {
  assert.equal(
    verdict.exhausted,
    true,
    `应判为额度用尽，实际 ${JSON.stringify(verdict)}`,
  );
  return verdict as Extract<QuotaVerdict, { exhausted: true }>;
}

test("codex / ChatGPT 样本：Try again in ~6826 min → now + 6826 分钟", () => {
  const verdict = hit(
    detect(
      sample("codex-usage-limit.txt"),
      new Date("2026-09-27T10:00:00+08:00"),
    ),
  );
  assert.equal(verdict.provider, "codex");
  assert.equal(verdict.resetAt?.toISOString(), "2026-10-01T19:46:00.000Z");
  assert.match(verdict.reason, /6826 分钟/);
  assert.match(verdict.reason, /You have hit your ChatGPT usage limit/);
});

test("Claude 样本：resets 3:50pm (Asia/Shanghai) → 当天 15:50（上海）", () => {
  const verdict = hit(
    detect(
      sample("claude-session-limit.txt"),
      new Date("2026-09-27T10:00:00+08:00"),
      {
        tool: "claude",
      },
    ),
  );
  assert.equal(verdict.provider, "claude");
  assert.equal(verdict.resetAt?.toISOString(), "2026-09-27T07:50:00.000Z");
  assert.match(verdict.reason, /Asia\/Shanghai 15:50/);
});

test("通用 HTTP 样本：429 + Retry-After 秒数 → now + 秒", () => {
  const verdict = hit(
    detect(
      sample("http-429-retry-after-seconds.txt"),
      new Date("2026-09-27T11:00:00Z"),
    ),
  );
  assert.equal(verdict.resetAt?.toISOString(), "2026-09-27T11:02:00.000Z");
  assert.match(verdict.reason, /Retry-After 120/);
});

test("通用 HTTP 样本：429 + retry-after HTTP 日期 → 该日期时刻", () => {
  const verdict = hit(
    detect(
      sample("http-429-retry-after-date.txt"),
      new Date("2026-09-27T11:00:00Z"),
    ),
  );
  assert.equal(verdict.resetAt?.toISOString(), "2026-09-27T20:00:00.000Z");
  assert.match(verdict.reason, /Retry-After/);
});

test("像额度但没有时间：usage limit reached → exhausted 且恢复时间未知", () => {
  const verdict = hit(
    detect(sample("usage-limit-no-time.txt"), new Date("2026-09-27T11:00:00Z")),
  );
  assert.equal(verdict.resetAt, null);
  assert.match(verdict.reason, /没有解析出恢复时间/);
  assert.match(verdict.reason, /usage limit reached/);
});

test("反例：认证失败日志不判额度", () => {
  assert.deepEqual(
    detect(sample("auth-failure.txt"), new Date("2026-09-27T11:00:00Z")),
    { exhausted: false },
  );
});

test("反例：网络超时日志不判额度", () => {
  assert.deepEqual(
    detect(sample("network-timeout.txt"), new Date("2026-09-27T11:00:00Z")),
    { exhausted: false },
  );
});

test("反例：测试失败日志不判额度", () => {
  assert.deepEqual(
    detect(sample("test-failure.txt"), new Date("2026-09-27T11:00:00Z")),
    { exhausted: false },
  );
});

test("跨午夜：16:00 收到「resets 3:50pm」取次日 15:50（上海）", () => {
  const verdict = hit(
    detect(
      sample("claude-session-limit.txt"),
      new Date("2026-09-27T16:00:00+08:00"),
      {
        tool: "claude",
      },
    ),
  );
  assert.equal(verdict.resetAt?.toISOString(), "2026-09-28T07:50:00.000Z");
});

test("跨时区：消息写 America/New_York，按该时区的 21:30 换算，不看本机时区", () => {
  const text =
    "You've hit your session limit · resets 9:30pm (America/New_York)\n";
  const verdict = hit(
    detect(text, new Date("2026-09-27T20:00:00+08:00"), { tool: "claude" }),
  );
  assert.equal(verdict.resetAt?.toISOString(), "2026-09-28T01:30:00.000Z");
  assert.match(verdict.reason, /America\/New_York 21:30/);
});

test("退出码 0：即便日志里有额度报文也不判额度（任务已经正常结束）", () => {
  assert.deepEqual(
    detect(
      sample("codex-usage-limit.txt"),
      new Date("2026-09-27T10:00:00+08:00"),
      {
        exitCode: 0,
      },
    ),
    { exhausted: false },
  );
});

test("t29 重启日志：摘要命令 quota 与 allowed 信息事件都不是额度错误", () => {
  const log = sample("t29-restart-success.jsonl");
  assert.equal(quotaErrorText(log), "");
  assert.deepEqual(
    detect(log, new Date("2026-09-27T10:47:00+08:00"), {
      exitCode: null,
      tool: "claude",
    }),
    { exhausted: false },
  );
});

test("t32 重启日志：例行 rate_limit_event 包含 overageStatus=rejected 也不算受限", () => {
  const log = sample("t32-restart-success.jsonl");
  assert.equal(quotaErrorText(log), "");
  assert.deepEqual(
    detect(log, new Date("2026-09-27T11:13:00+08:00"), {
      exitCode: null,
      tool: "claude",
    }),
    { exhausted: false },
  );
});

test("助手正文、工具结果、单独 quota/用量 不算信号；受限 status 和错误结构才算", () => {
  const now = new Date("2026-09-27T11:13:00+08:00");
  for (const text of [
    "quota\n用量\n",
    '{"type":"assistant","message":{"content":[{"type":"text","text":"quota exceeded 429"}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result","content":"quota exceeded 429"}]}}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","overageStatus":"rejected"}}',
  ])
    assert.deepEqual(
      detect(text, now, { exitCode: null, tool: "claude" }),
      { exhausted: false },
      text,
    );
  assert.equal(
    hit(
      detect(
        '{"type":"rate_limit_event","rate_limit_info":{"status":"rate_limited"}}',
        now,
        { tool: "claude" },
      ),
    ).provider,
    "claude",
  );
  assert.equal(
    hit(
      detect(
        '{"type":"result","is_error":true,"error":"quota exceeded"}',
        now,
        { tool: "claude" },
      ),
    ).provider,
    "claude",
  );
});

test("只取退出前最后一条错误报文；后续正常结束清掉旧额度事件", () => {
  const now = new Date("2026-09-27T11:13:00+08:00");
  assert.deepEqual(
    detect("ERROR quota exceeded\nERROR authentication required", now),
    { exhausted: false },
  );
  assert.deepEqual(
    detect(
      '{"type":"error","error":"rate limit exceeded"}\n{"type":"result","is_error":false,"stop_reason":"end_turn"}',
      now,
    ),
    { exhausted: false },
  );
});
