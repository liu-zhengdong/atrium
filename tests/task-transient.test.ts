/**
 * 供应商或网络临时错误（#262）：判定、去向与计数的纯函数，以及挑人时避开正忙的独占执行者。
 * opencode 夹具按夜间实跑报出的原文构造（原日志已被重跑覆盖）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { idleFirst } from "../server/tasks/idle-first.ts";
import { pickWorker } from "../server/tasks/prepare.ts";
import { detectQuotaExhausted } from "../server/tasks/quota-signal.ts";
import { abnormalEnding, parseEvents } from "../server/tasks/json-log.ts";
import {
  detectTransient,
  routeAfterTransient,
  transientAttempts,
} from "../server/tasks/transient.ts";

const cert = readFileSync(
  new URL("./fixtures/transient/opencode-cert.jsonl", import.meta.url),
  "utf8",
);

test("临时错误：opencode 出错事件（证书校验）判出，证据取事件正文", () => {
  const hit = detectTransient({ exitCode: 1, logTail: cert, json: true });
  assert.ok(hit);
  assert.equal(hit.reason, "供应商或网络临时错误：证书校验出错");
  assert.equal(
    hit.evidence,
    "UnknownError: unknown certificate verification error",
  );
  // 与额度、权限、长度分开：同一份日志不判额度，结构化结局只是中途退出。
  assert.equal(
    detectQuotaExhausted({
      exitCode: 1,
      logTail: cert,
      now: new Date(),
      tool: "opencode",
    }).exhausted,
    false,
  );
  assert.equal(abnormalEnding(parseEvents(cert))?.kind, "midway");
});

test("临时错误：各类报文都能判出类别", () => {
  const cases: [string, boolean, string][] = [
    [
      '{"type":"error","error":{"name":"APIError","message":"fetch failed"}}',
      true,
      "网络请求失败",
    ],
    [
      '{"type":"result","subtype":"success","is_error":true,"result":"API Error: 529 {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"overloaded_error\\",\\"message\\":\\"Overloaded\\"}}"}',
      true,
      "供应商过载",
    ],
    [
      '{"type":"result","is_error":true,"result":"API Error: 500 Internal Server Error"}',
      true,
      "供应商服务端错误（5xx）",
    ],
    ["working\nError: read ECONNRESET", false, "网络连接出错"],
    [
      "stream error: stream disconnected before completion",
      false,
      "网络连接出错",
    ],
    [
      "ERROR: unexpected status 502 Bad Gateway",
      false,
      "供应商服务端错误（5xx）",
    ],
    ["HTTP 503 from upstream", false, "供应商服务端错误（5xx）"],
    ["TypeError: fetch failed", false, "网络请求失败"],
    [
      "Error: self-signed certificate in certificate chain",
      false,
      "证书校验出错",
    ],
    // 结构化日志里混进来的 stderr 行也看。
    [
      '{"type":"step_start","part":{}}\nError: getaddrinfo ENOTFOUND api.example.com',
      true,
      "网络连接出错",
    ],
  ];
  for (const [logTail, json, kind] of cases) {
    const hit = detectTransient({ exitCode: 1, logTail, json });
    assert.equal(hit?.reason, `供应商或网络临时错误：${kind}`, logTail);
  }
});

test("临时错误：正常退出、被信号结束、读到的文件内容、更早的日志、非临时的出错事件都不判", () => {
  assert.equal(
    detectTransient({ exitCode: 0, logTail: cert, json: true }),
    undefined,
  );
  assert.equal(
    detectTransient({ exitCode: null, logTail: cert, json: true }),
    undefined,
  );
  // 工具读到的源码里有这些词（JSON 行内），最后没有出错事件：不判。
  const read = cert.split("\n").slice(0, 3).join("\n");
  assert.equal(
    detectTransient({ exitCode: 1, logTail: read, json: true }),
    undefined,
  );
  // 最后一个出错事件不是临时错误：不往前找。
  const later = `${cert}{"type":"error","error":{"name":"ProviderModelNotFoundError","data":{"message":"model not found"}}}\n`;
  assert.equal(
    detectTransient({ exitCode: 1, logTail: later, json: true }),
    undefined,
  );
  // 文本日志只看末尾几行。
  const old = `fetch failed\n${Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")}`;
  assert.equal(
    detectTransient({ exitCode: 1, logTail: old, json: false }),
    undefined,
  );
  // 额度与限流不归这里：429 不算 5xx。
  assert.equal(
    detectTransient({
      exitCode: 1,
      logTail: "Error: 429 Too Many Requests",
      json: false,
    }),
    undefined,
  );
  assert.equal(
    detectTransient({
      exitCode: 1,
      logTail: "exit status 1: tests failed",
      json: false,
    }),
    undefined,
  );
});

test("临时错误去向：先同一执行者，再换执行者，再失败；档案可关", () => {
  assert.deepEqual(routeAfterTransient({ allowed: true, attempts: 0 }), {
    kind: "same",
    attempt: 1,
  });
  assert.deepEqual(routeAfterTransient({ allowed: true, attempts: 1 }), {
    kind: "switch",
    attempt: 2,
  });
  assert.equal(
    routeAfterTransient({ allowed: true, attempts: 2 }).kind,
    "fail",
  );
  assert.equal(
    routeAfterTransient({ allowed: false, attempts: 0 }).kind,
    "fail",
  );
});

test("临时错误计数：从最后一次非重试拉起往后数，人工再派重新计数", () => {
  const start = (retry?: boolean) => ({
    kind: "start",
    detail: JSON.stringify({
      from: "todo",
      to: "running",
      detail: retry ? { retry: true } : {},
    }),
  });
  const again = { kind: "transient_retry", detail: "{}" };
  const fail = { kind: "exit_fail", detail: null };
  assert.equal(transientAttempts([]), 0);
  assert.equal(transientAttempts([start(), fail]), 0);
  assert.equal(transientAttempts([start(), fail, again, start(true), fail]), 1);
  assert.equal(
    transientAttempts([
      start(),
      fail,
      again,
      start(true),
      fail,
      again,
      start(true),
      fail,
    ]),
    2,
  );
  assert.equal(
    transientAttempts([
      start(),
      fail,
      again,
      start(true),
      fail,
      again,
      start(true),
      fail,
      start(),
      fail,
    ]),
    0,
  );
  assert.equal(transientAttempts([{ kind: "start", detail: "坏" }, again]), 1);
});

test("挑人：正忙的独占执行者排到空闲候选之后，只剩它时仍挑它；exclude 跳过", () => {
  assert.deepEqual(
    idleFirst(["opencode", "claude", "kimi"], new Set(["opencode"])),
    ["claude", "kimi", "opencode"],
  );
  // 非独占的忙不影响顺序。
  assert.deepEqual(idleFirst(["claude", "opencode"], new Set(["claude"])), [
    "claude",
    "opencode",
  ]);
  assert.deepEqual(idleFirst(["opencode", "claude"], undefined), [
    "opencode",
    "claude",
  ]);

  const pace = [
    { providerId: "opencode", sparePercent: 60 },
    { providerId: "claude", sparePercent: 55 },
  ];
  const idle = pickWorker({
    installed: ["opencode", "claude"],
    pace,
    risk: "low",
    profiles: {},
  });
  assert.ok(idle.ok && idle.tool === "opencode");
  const busy = pickWorker({
    installed: ["opencode", "claude"],
    pace,
    risk: "low",
    profiles: {},
    busy: new Set(["opencode"]),
  });
  assert.ok(busy.ok);
  assert.deepEqual(
    [busy.tool, busy.spare, busy.basis, busy.available],
    ["claude", 55, "pace", ["claude", "opencode"]],
  );
  // pace 不可用时同样避开。
  const fallback = pickWorker({
    installed: ["opencode", "kimi"],
    risk: "low",
    profiles: {},
    busy: new Set(["opencode"]),
  });
  assert.ok(fallback.ok && fallback.tool === "kimi");
  // 唯一可选：仍挑它，由调用方排队。
  const only = pickWorker({
    installed: ["opencode"],
    pace,
    risk: "low",
    profiles: {},
    busy: new Set(["opencode"]),
  });
  assert.ok(only.ok && only.tool === "opencode");
  const excluded = pickWorker({
    installed: ["opencode", "claude"],
    pace,
    risk: "low",
    profiles: {},
    exclude: new Set(["opencode"]),
  });
  assert.ok(excluded.ok && excluded.tool === "claude");
  assert.match(
    excluded.skipped.find((s) => s.tool === "opencode")!.reason,
    /临时错误/,
  );
});
