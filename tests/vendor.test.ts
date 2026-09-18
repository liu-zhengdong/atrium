import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

test("本地 pi-acp 构建包与 lockfile、来源说明的校验值一致", () => {
  const bytes = readFileSync(
    new URL("../vendor/liuser-pi-acp-0.2.0.tgz", import.meta.url),
  );
  const lock = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  const checksum = (value: Buffer) =>
    "sha512-" + createHash("sha512").update(value).digest("base64");
  const expected = lock.packages["node_modules/@liuser/pi-acp"].integrity;
  const verify = (value: Buffer) =>
    assert.equal(
      checksum(value),
      expected,
      "本地包已变化，请更新 lockfile 并使用空缓存 npm ci",
    );
  verify(bytes);
  const corrupted = Buffer.from(bytes);
  corrupted[0] = corrupted[0]! ^ 1;
  assert.throws(() => verify(corrupted), /本地包已变化/);
  const documented = readFileSync(
    new URL("../vendor/README.md", import.meta.url),
    "utf8",
  );
  assert(
    documented.includes(createHash("sha256").update(bytes).digest("hex")),
    "构建来源说明中的 SHA-256 必须同步",
  );
});
