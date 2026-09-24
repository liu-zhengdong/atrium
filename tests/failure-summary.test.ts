import assert from "node:assert/strict";
import { test } from "node:test";
import { failureSummary } from "../web/components/failure-summary.ts";
import { pastTime } from "../web/time.ts";

test("extracts a readable message from status-prefixed JSON", () => {
  assert.equal(
    failureSummary(
      '401: {"message":"Authentication Fails, Your api key: ****0924 is invalid","code":401}',
    ),
    "401 · Authentication Fails, Your api key: ****0924 is invalid",
  );
  assert.equal(
    failureSummary('400: {"error":{"message":"Unknown model"}}'),
    "400 · Unknown model",
  );
});

test("keeps non-JSON and malformed JSON readable, truncates only the summary", () => {
  assert.equal(
    failureSummary("  connection\n refused  "),
    "connection refused",
  );
  assert.equal(
    failureSummary('401: {"message":oops}'),
    '401: {"message":oops}',
  );
  assert.equal(failureSummary('401: {"code":401}'), '401: {"code":401}');
  const long = '500: {"error":{"message":"' + "x".repeat(200) + '"}}';
  assert.equal(failureSummary(long), "500 · " + "x".repeat(104) + "…");
});

test("summarizes a model service failure without hiding its original text in the drawer", () => {
  assert.equal(
    failureSummary("Model provider returned 503 unavailable"),
    "模型服务报错",
  );
});

test("relative failure time", () => {
  assert.equal(pastTime(820_000, 1_000_000), "3 分钟前");
  assert.equal(pastTime(999_000, 1_000_000), "刚刚");
});
