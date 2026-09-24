import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareProfile, syncIdentityProfile } from "../server/profile.ts";

test("新身份不复制或链接个人 Pi 登录；已有身份启动不自动继承", () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-no-shared-auth-"));
  try {
    const template = join(root, "template");
    mkdirSync(template);
    writeFileSync(
      join(template, "settings.json"),
      JSON.stringify({ packages: [] }),
    );
    writeFileSync(join(template, "auth.json"), "PERSONAL_TOKEN");
    const one = prepareProfile("id1", template, join(root, ".pi"));
    const two = prepareProfile("id2", template, join(root, ".pi"));
    assert.equal(existsSync(join(one, "auth.json")), false);
    assert.equal(existsSync(join(two, "auth.json")), false);
    writeFileSync(join(one, "auth.json"), "OWN_TOKEN");
    assert.deepEqual(syncIdentityProfile(one), []);
    assert.equal(readFileSync(join(one, "auth.json"), "utf8"), "OWN_TOKEN");
    assert.equal(
      readFileSync(join(template, "auth.json"), "utf8"),
      "PERSONAL_TOKEN",
    );
    assert.equal(existsSync(join(two, "auth.json")), false);
    writeFileSync(join(two, "auth.json"), "{}");
    assert.deepEqual(syncIdentityProfile(two), []);
    assert.equal(lstatSync(join(two, "auth.json")).isSymbolicLink(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
