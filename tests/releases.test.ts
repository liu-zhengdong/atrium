import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSemver,
  compareSemver,
  getChangesBetween,
  readLocalReleases,
} from "../server/releases.ts";

test("parseSemver 解析标准版本号与 v 前缀", () => {
  const v1 = parseSemver("0.1.0");
  assert.deepEqual(v1, [0, 1, 0, ""]);

  const v2 = parseSemver("v1.2.3");
  assert.deepEqual(v2, [1, 2, 3, ""]);

  const v3 = parseSemver("v2.0.0-rc.1");
  assert.deepEqual(v3, [2, 0, 0, "rc.1"]);

  assert.throws(() => parseSemver("invalid"), /无效的语义化版本号/);
});

test("compareSemver 正确比较版本号先后顺序", () => {
  assert.equal(compareSemver("0.1.0", "0.1.0"), 0);
  assert.equal(compareSemver("0.1.0", "0.1.1") < 0, true);
  assert.equal(compareSemver("0.2.0", "0.1.9") > 0, true);
  assert.equal(compareSemver("1.0.0", "0.9.9") > 0, true);
  assert.equal(compareSemver("v1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0") < 0, true);
});

test("readLocalReleases 读取本地 releases.json", () => {
  const releases = readLocalReleases();
  assert(Object.keys(releases).length >= 1);
  assert.equal(typeof releases["0.1.0"], "string");
});

test("getChangesBetween 提取版本间的更新摘要", () => {
  const empty = getChangesBetween("0.1.0", "0.1.0");
  assert.deepEqual(empty, []);

  // When from > to
  const reverse = getChangesBetween("0.2.0", "0.1.0");
  assert.deepEqual(reverse, []);
});
