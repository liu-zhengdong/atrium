import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import { authPolicy } from "../server/auth-policy.ts";
import { declaredBodyWithoutBytes } from "./raw-http.ts";
import { removeTemp } from "./temp-dir.ts";

function rawRequest(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setTimeout(2500, () => socket.destroy(new Error("request timeout")));
    socket.on("connect", () =>
      socket.write(
        `${method} ${path} HTTP/1.1\r\nHost: atrium.localhost:${port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      ),
    );
    socket.on("data", (chunk) => (response += chunk.toString()));
    socket.on("error", reject);
    socket.on("end", () => {
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1]);
      resolve({
        status,
        body: response.split("\r\n\r\n").slice(1).join("\r\n\r\n"),
      });
    });
  });
}

async function listen(
  t: { after: (fn: () => unknown) => void },
  onRoute?: (method: string, url: string) => void,
) {
  const data = mkdtempSync(join(tmpdir(), "atrium-auth-routes-"));
  t.after(() => removeTemp(data));
  const { app } = await createApp({
    data,
    onRoute,
    tasks: { pace: async () => undefined },
  });
  t.after(() => app.close());
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return Number(new URL(address).port);
}

test("所有已注册的全景 GET 接口都允许网页只读会话，令牌专用接口显式列出", async (t) => {
  const routes: { method: string; url: string }[] = [];
  await listen(t, (method, url) => routes.push({ method, url }));
  const tokenOnly = new Set(["/api/map/context/:id"]);
  const mapGets = routes.filter(
    ({ method, url }) => method === "GET" && url.startsWith("/api/map/"),
  );
  assert.ok(mapGets.length > tokenOnly.size);
  for (const route of mapGets) {
    assert.equal(
      authPolicy(route.method, route.url),
      tokenOnly.has(route.url) ? "user" : "map-read",
      `${route.method} ${route.url}`,
    );
  }
  assert.deepEqual(
    mapGets.filter(({ url }) => tokenOnly.has(url)).map(({ url }) => url),
    [...tokenOnly],
    "令牌专用例外必须仍是已注册路由",
  );
});

test("anonymous requests are rejected before their declared body is read", async (t) => {
  const routes: { method: string; url: string }[] = [];
  const port = await listen(t, (method, url) => routes.push({ method, url }));
  assert.equal(await declaredBodyWithoutBytes(port, "/api/tasks"), 401);
  assert.equal(await declaredBodyWithoutBytes(port, "/%61pi/tasks"), 401);
  const exceptions = routes
    .filter(
      ({ method, url }) =>
        method === "POST" && authPolicy(method, url) !== "user",
    )
    .map(({ url }) => url);
  assert.deepEqual(exceptions.sort(), [
    "/api/agent/exit",
    "/api/agent/hello",
    "/api/agent/join",
    "/api/agent/log",
    "/api/agent/poll",
    "/api/agent/quota",
    "/api/agent/reply",
    "/api/auth/rotate",
    "/api/choices/:id/pass",
    "/api/choices/:id/pick",
  ]);
  assert.equal(await declaredBodyWithoutBytes(port, "/api/auth/rotate"), 401);
  // 网页拍板（map-write）没有令牌也没有会话时同样在读请求体之前拒绝。
  for (const path of ["/api/choices/c1/pick", "/api/choices/c1/pass"])
    assert.equal(await declaredBodyWithoutBytes(port, path), 401, path);
  // 代理接口（#358）同样在读请求体之前认接入码或主机令牌。
  for (const path of exceptions.filter((url) => url.startsWith("/api/agent/")))
    assert.equal(await declaredBodyWithoutBytes(port, path), 401, path);
});

test("raw HTTP encoded and normalized paths cannot bypass auth", async (t) => {
  const port = await listen(t);
  const prefixes = [
    "/%61pi/",
    "/ap%69/",
    "/%2561pi/",
    "/API/",
    "/%61pi;x/",
    "//api/",
    "/./api/",
    "/x/../api/",
    "/api%2F",
    "/api/",
    "/api/service/../",
    "/api/service/%2e%2e/",
  ];
  const suffixes = ["tasks", "org/tree", "quota", "auth/rotate"];
  const suffixVariants = ["", "/", ";x", "?x", "#x"];
  const failures: string[] = [];
  for (const method of ["GET", "POST"]) {
    for (const suffix of suffixes) {
      for (const prefix of prefixes) {
        for (const ending of prefix === "/api/" ? suffixVariants : [""]) {
          const path = `${prefix}${suffix}${ending}`;
          const { status, body } = await rawRequest(port, method, path);
          if (![401, 403, 404].includes(status) || /"rotated"/.test(body))
            failures.push(`${method} ${path} -> ${status}`);
        }
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    "all path variants must reject anonymous clients",
  );
});
