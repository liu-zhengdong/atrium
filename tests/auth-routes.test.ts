import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/legacy-app.ts";
import { authPolicy, protectedNamespace } from "../server/auth-policy.ts";
import { declaredBodyWithoutBytes } from "./raw-http.ts";

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

test("onRoute audit: every registered route defaults to user auth; exceptions are explicit", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-route-audit-"));
  const webRoot = join(data, "web");
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, "index.html"), "<h1>public shell</h1>");
  const routes: { method: string; url: string }[] = [];
  const { app } = await createApp({
    data,
    runtime: false,
    webRoot,
    onRoute: (method, url) => routes.push({ method, url }),
  });
  try {
    assert(
      routes.length > 80,
      `audit needs full route registry, got ${routes.length}`,
    );
    const exceptions = [
      ...new Set(
        routes
          .filter(({ method, url }) => authPolicy(method, url) !== "user")
          .map(({ method, url }) => `${method} ${url}`),
      ),
    ].sort();
    assert.deepEqual(
      exceptions,
      [
        "GET /*",
        "GET /api/auth/session",
        "GET /auth/claim/:code",
        "HEAD /*",
        "HEAD /api/auth/session",
        "HEAD /auth/claim/:code",
        "POST /api/auth/rotate",
        "POST /hooks/:ref/:token",
        "POST /mcp/:id",
      ].sort(),
    );
    for (const { method, url } of routes) {
      if (authPolicy(method, url) !== "user") continue;
      const concrete = url.replace(/:[\w]+/g, "a1");
      const response = await app.inject({
        method: method as "GET",
        url: concrete,
      });
      assert.equal(
        response.statusCode,
        401,
        `${method} ${url} must be private by default`,
      );
    }
  } finally {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  }
});

test("negative control: without the user-auth guard an encoded API path reaches private data", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-auth-off-"));
  const { app } = await createApp({ data, runtime: false, auth: false });
  try {
    const response = await app.inject({ url: "/%61pi/overview" });
    assert.equal(response.statusCode, 200);
    assert("agents" in response.json());
  } finally {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  }
});

test("anonymous requests are rejected before their declared body is read", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-body-before-auth-"));
  const routes: { method: string; url: string }[] = [];
  const { app } = await createApp({
    data,
    runtime: false,
    onRoute: (method, url) => routes.push({ method, url }),
  });
  try {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const port = Number(new URL(address).port);
    assert.equal(await declaredBodyWithoutBytes(port, "/api/runners"), 401);
    assert.equal(await declaredBodyWithoutBytes(port, "/%61pi/runners"), 401);
    const exceptions = routes
      .filter(
        ({ method, url }) =>
          method === "POST" && authPolicy(method, url) !== "user",
      )
      .map(({ url }) => url)
      .sort();
    assert.deepEqual(exceptions, [
      "/api/auth/rotate",
      "/hooks/:ref/:token",
      "/mcp/:id",
    ]);
    for (const url of exceptions) {
      const path = url.replace(/:[^/]+/g, (param) =>
        param === ":id" ? "00000000-0000-4000-8000-000000000000" : "a1",
      );
      const status = url.startsWith("/hooks/") ? 404 : 401;
      assert.equal(await declaredBodyWithoutBytes(port, path), status, path);
    }
    assert.equal(
      await declaredBodyWithoutBytes(
        port,
        "/%6dcp/00000000-0000-4000-8000-000000000000",
      ),
      401,
    );
  } finally {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  }
});

test("raw HTTP encoded and normalized paths cannot bypass auth or leak the SPA shell", async () => {
  const data = mkdtempSync(join(tmpdir(), "atrium-path-variants-"));
  const webRoot = join(data, "web");
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, "index.html"), "<h1>public shell</h1>");
  const { app } = await createApp({ data, runtime: false, webRoot });
  try {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const port = Number(new URL(address).port);
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
      "/hooks/../api/",
    ];
    const suffixes = ["overview", "auth/link", "runners"];
    const suffixVariants = ["", "/", ";x", "?x", "#x"];
    const failures: string[] = [];
    for (const method of ["GET", "POST"]) {
      for (const suffix of suffixes) {
        for (const prefix of prefixes) {
          for (const ending of prefix === "/api/" ? suffixVariants : [""]) {
            const path = `${prefix}${suffix}${ending}`;
            const { status, body } = await rawRequest(port, method, path);
            if (
              ![401, 403, 404].includes(status) ||
              /public shell|"code":"[a-f0-9]{64}"|"runnerId"/.test(body)
            )
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
    assert(protectedNamespace("/%2561pi/unknown"));
    for (const path of ["/api;x", "/%61pi;x", "/api%3Bx"]) {
      const response = await rawRequest(port, "GET", path);
      assert.equal(response.status, 404, path);
      assert.doesNotMatch(response.body, /public shell/);
    }
  } finally {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  }
});
