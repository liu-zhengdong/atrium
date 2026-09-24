import assert from "node:assert/strict";
import { test } from "node:test";
import { identityEnvironment } from "../server/runtime.ts";

test("drops herdr pane scope but keeps the connection to herdr", () => {
  const env = identityEnvironment({
    PATH: "/usr/bin",
    HERDR_ENV: "1",
    HERDR_PANE_ID: "wG:pX",
    HERDR_TAB_ID: "wG:tX",
    HERDR_WORKSPACE_ID: "wG",
    HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    HERDR_BIN_PATH: "/usr/local/bin/herdr",
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    HERDR_BIN_PATH: "/usr/local/bin/herdr",
  });
});

test("leaves the caller's environment untouched", () => {
  const source = { HERDR_PANE_ID: "wG:pX" };
  identityEnvironment(source);
  assert.equal(source.HERDR_PANE_ID, "wG:pX");
});
