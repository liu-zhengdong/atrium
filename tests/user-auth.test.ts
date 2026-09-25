import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import { cookieName, userTokenPath } from "../server/user-auth.ts";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("hex");

async function fixture() {
  const data = mkdtempSync(join(tmpdir(), "atrium-auth-test-"));
  const { app, store } = await createApp({
    data,
    runtime: false,
    controlToken: "fixture-control",
  });
  const token = readFileSync(userTokenPath(data), "utf8").trim();
  const close = async () => {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  };
  return { data, app, store, token, close };
}

test("interrupted first boot preserves an invalid token file and starts with a new one", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-auth-recover-"));
  writeFileSync(userTokenPath(data), "broken", { mode: 0o600 });
  const { app } = await createApp({ data, runtime: false });
  try {
    const files = readdirSync(data);
    assert(files.some((name) => name.startsWith("user-token.invalid-")));
    assert.match(readFileSync(userTokenPath(data), "utf8"), /^[a-f0-9]{64}\n$/);
    assert.equal(statSync(userTokenPath(data)).mode & 0o777, 0o600);
  } finally {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  }
});

test("all user API requires bearer or session, identity MCP never accepts user bearer", async () => {
  const f = await fixture();
  try {
    const unauth = await f.app.inject({ url: "/api/overview" });
    assert.equal(unauth.statusCode, 401);
    assert.match(unauth.json().error, /服务已升级，请重新运行/);
    assert.equal(
      (
        await f.app.inject({
          url: "/api/overview",
          headers: { authorization: `Bearer ${f.token}` },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/overview",
          headers: { authorization: `bearer ${f.token}` },
        })
      ).statusCode,
      200,
    );
    const { agent, token } = f.store.createAgent("测试", f.data);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/mcp/${agent.id}`,
          headers: { authorization: `Bearer ${f.token}` },
        })
      ).statusCode,
      401,
    );
    assert(f.store.authenticate(agent.id, token));
    assert.notEqual(
      (
        await f.app.inject({
          method: "POST",
          url: `/mcp/${agent.id}`,
          headers: { authorization: `bearer ${token}` },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/overview",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/overview",
          headers: { host: "evil.example", authorization: `Bearer ${f.token}` },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/chats",
          headers: {
            host: "atrium.localhost:4338",
            origin: "http://evil.example",
            authorization: `Bearer ${f.token}`,
          },
        })
      ).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});

test("login link one-use/60s, per-instance cookie, slide 30 days, logout and rotate revoke all", async () => {
  const f = await fixture();
  try {
    const link = await f.app.inject({
      method: "POST",
      url: "/api/auth/link",
      headers: { authorization: `Bearer ${f.token}` },
    });
    const code = link.json().code as string;
    assert.match(code, /^[a-f0-9]{64}$/);
    assert.equal(
      (
        await f.app.inject({
          url: `/auth/claim/${code}`,
          headers: { host: "127.0.0.1:4338" },
        })
      ).statusCode,
      403,
    );
    const claim = await f.app.inject({
      url: `/auth/claim/${code}`,
      headers: { host: "atrium.localhost:4338" },
    });
    assert.equal(claim.statusCode, 302);
    const cookie = claim.headers["set-cookie"] as string;
    assert(cookie.startsWith(`${cookieName(f.data)}=`));
    assert(cookie.includes("SameSite=Strict") && cookie.includes("HttpOnly"));
    const replay = await f.app.inject({
      url: `/auth/claim/${code}`,
      headers: { host: "atrium.localhost:4338" },
    });
    assert.equal(replay.statusCode, 401);
    assert.match(replay.headers["content-type"] as string, /text\/html/);
    assert.match(replay.body, /登录链接已失效.*atrium open/s);
    const expiring = (
      await f.app.inject({
        method: "POST",
        url: "/api/auth/link",
        headers: { authorization: `Bearer ${f.token}` },
      })
    ).json().code as string;
    const originalNow = Date.now;
    try {
      const now = originalNow();
      Date.now = () => now + 61_000;
      assert.equal(
        (
          await f.app.inject({
            url: `/auth/claim/${expiring}`,
            headers: { host: "atrium.localhost:4338" },
          })
        ).statusCode,
        401,
      );
    } finally {
      Date.now = originalNow;
    }
    assert.equal(
      (
        await f.app.inject({
          url: "/api/overview",
          headers: { cookie, host: "atrium.localhost:4338" },
        })
      ).statusCode,
      200,
    );
    const sessionHash = hash(cookie.split("=", 2)[1]!.split(";", 1)[0]!);
    f.store.run(
      "UPDATE web_sessions SET expires_at=? WHERE token_hash=?",
      Date.now() + 2_000,
      sessionHash,
    );
    await f.app.inject({
      url: "/api/overview",
      headers: { cookie, host: "atrium.localhost:4338" },
    });
    assert(
      (f.store.one<{ expires_at: number }>(
        "SELECT expires_at FROM web_sessions WHERE token_hash=?",
        sessionHash,
      )?.expires_at ?? 0) >
        Date.now() + 29 * 86400000,
    );
    const logout = await f.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie, host: "atrium.localhost:4338" },
    });
    assert.equal(logout.statusCode, 200);
    assert.equal(
      (
        await f.app.inject({
          url: "/api/overview",
          headers: { cookie, host: "atrium.localhost:4338" },
        })
      ).statusCode,
      401,
    );
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
    assert.notEqual(
      readFileSync(userTokenPath(f.data), "utf8").trim(),
      f.token,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/overview",
          headers: { authorization: `Bearer ${f.token}` },
        })
      ).statusCode,
      401,
    );
    assert.notEqual(cookieName(f.data), cookieName(f.data + "-other"));
  } finally {
    await f.close();
  }
});

test("a webhook token writes only its own inbox and cannot call /api or another agent", async () => {
  const f = await fixture();
  try {
    const a = f.store.createAgent("甲", f.data).agent;
    const b = f.store.createAgent("乙", f.data).agent;
    const aRef = f.store.agentRef(a.id),
      bRef = f.store.agentRef(b.id);
    const hook = secret();
    const withUser = { authorization: `Bearer ${f.token}` };
    assert.equal(
      (
        await f.app.inject({
          method: "PUT",
          url: `/api/agents/${aRef}/adapters/url`,
          headers: withUser,
          payload: { tokenHash: hash(hook) },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/agents/${aRef}/inbox`,
          payload: { sample: true },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/hooks/${bRef}/${hook}`,
          payload: { sample: true },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/hooks/${aRef}/bad`,
          payload: { sample: true },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/overview",
          headers: { authorization: `Bearer ${hook}` },
        })
      ).statusCode,
      401,
    );
    const posted = await f.app.inject({
      method: "POST",
      url: `/hooks/${aRef}/${hook}`,
      payload: { sample: true },
    });
    assert.equal(posted.statusCode, 200, posted.body);
    const oversized = await f.app.inject({
      method: "POST",
      url: `/hooks/${aRef}/${hook}`,
      headers: { "content-type": "text/plain" },
      payload: "x".repeat(256 * 1024 + 1),
    });
    assert.equal(oversized.statusCode, 413);
    assert.equal(
      f.store.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM inbox WHERE agent_id=?",
        a.id,
      )?.n,
      1,
    );
    assert.equal(
      f.store.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM inbox WHERE agent_id=?",
        b.id,
      )?.n,
      0,
    );
    await f.app.inject({
      method: "PUT",
      url: `/api/agents/${aRef}/adapters/url`,
      headers: withUser,
      payload: { tokenHash: null },
    });
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/hooks/${aRef}/${hook}`,
          payload: "no",
        })
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});
