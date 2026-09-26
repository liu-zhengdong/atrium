import { test } from "node:test";
import assert from "node:assert/strict";
import { readableTime } from "../server/time.ts";

test("可读时间：本机时区、带偏移量、补零，能原样解析回去", () => {
  const ms = Date.UTC(2026, 8, 26, 3, 14, 32);
  const text = readableTime(ms);
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/);
  // 本机时区渲染的结果带上偏移量后应解析回同一时刻，秒级一致。
  const iso = text.replace(" ", "T").replace(" ", "");
  assert.equal(new Date(iso).getTime(), ms);
  // 毫秒不进入可读时间，同一秒内的时间戳渲染一致。
  assert.equal(readableTime(ms + 999), readableTime(ms));
});
