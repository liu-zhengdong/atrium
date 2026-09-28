import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createApp } from "../server/app.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { tempDir } from "./temp-dir.ts";

async function fixture(t: { after: (fn: () => unknown) => void }) {
  const data = tempDir(t, "atrium-auth-test-");
  const { app } = await createApp({
    data,
    controlToken: "fixture-control",
    tasks: { pace: async () => undefined },
  });
  t.after(() => app.close());
  const token = readFileSync(userTokenPath(data), "utf8").trim();
  return { data, app, token };
}

test("interrupted first boot preserves an invalid token file and starts with a new one", async (t) => {
  const data = tempDir(t, "atrium-auth-recover-");
  writeFileSync(userTokenPath(data), "broken", { mode: 0o600 });
  const { app } = await createApp({
    data,
    tasks: { pace: async () => undefined },
  });
  t.after(() => app.close());
  const files = readdirSync(data);
  assert(files.some((name) => name.startsWith("user-token.invalid-")));
  assert.match(readFileSync(userTokenPath(data), "utf8"), /^[a-f0-9]{64}\n$/);
  // Windows 没有 POSIX 权限位，数据目录靠用户目录的 ACL。
  if (process.platform !== "win32")
    assert.equal(statSync(userTokenPath(data)).mode & 0o777, 0o600);
});

test("user API requires the bearer token and rejects foreign Host or Origin", async (t) => {
  const f = await fixture(t);
  const url = "/api/org/tree";
  const unauth = await f.app.inject({ url });
  assert.equal(unauth.statusCode, 401);
  assert.match(unauth.json().error, /服务已升级，请重新运行/);
  for (const scheme of ["Bearer", "bearer"])
    assert.equal(
      (
        await f.app.inject({
          url,
          headers: { authorization: `${scheme} ${f.token}` },
        })
      ).statusCode,
      200,
    );
  const wrong = await f.app.inject({
    url,
    headers: { authorization: `Bearer ${"0".repeat(64)}` },
  });
  assert.equal(wrong.statusCode, 401);
  assert.match(wrong.json().error, /用户认证失效/);
  assert.equal(
    (
      await f.app.inject({
        url,
        headers: { host: "evil.example", authorization: `Bearer ${f.token}` },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: {
          host: "atrium.localhost:4338",
          origin: "http://evil.example",
          authorization: `Bearer ${f.token}`,
        },
      })
    ).statusCode,
    403,
  );
});

test("rotate accepts the user or control credential and revokes the old token", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/auth/rotate",
        headers: { authorization: "Bearer bad" },
      })
    ).statusCode,
    401,
  );
  unlinkSync(userTokenPath(f.data));
  const rotated = await f.app.inject({
    method: "POST",
    url: "/api/auth/rotate",
    headers: { authorization: "Bearer fixture-control" },
  });
  assert.equal(rotated.statusCode, 200);
  const fresh = readFileSync(userTokenPath(f.data), "utf8").trim();
  assert.notEqual(fresh, f.token);
  // Windows 没有 POSIX 权限位，数据目录靠用户目录的 ACL。
  if (process.platform !== "win32")
    assert.equal(statSync(userTokenPath(f.data)).mode & 0o777, 0o600);
  assert.equal(
    (
      await f.app.inject({
        url: "/api/org/tree",
        headers: { authorization: `Bearer ${f.token}` },
      })
    ).statusCode,
    401,
  );
  const again = await f.app.inject({
    method: "POST",
    url: "/api/auth/rotate",
    headers: { authorization: `Bearer ${fresh}` },
  });
  assert.equal(again.statusCode, 200);
});
