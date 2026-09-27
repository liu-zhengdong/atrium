import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  classifyPortReply,
  portTakenMessage,
  probePort,
} from "../server/port-owner.ts";
import { dataDirectory, legacyDataNotice } from "../server/service-state.ts";

test("默认数据目录是 ~/.atrium，ATRIUM_DATA 可覆盖（t71）", () => {
  assert.equal(dataDirectory({}), join(homedir(), ".atrium"));
  assert.equal(dataDirectory({ ATRIUM_DATA: "/tmp/nope-x" }), "/tmp/nope-x");
});

test("只有前一代数据目录时提示已归档，其余情形不提示（t71）", () => {
  const home = "/h";
  const legacy = "/h/.pi/atrium/data";
  const has =
    (...paths: string[]) =>
    (path: string) =>
      paths.includes(path);
  assert.equal(
    legacyDataNotice({}, home, has(legacy)),
    "前一代数据在 /h/.pi/atrium/data，已归档，不再使用；新一代数据放在 /h/.atrium（可用 ATRIUM_DATA 改）",
  );
  assert.equal(legacyDataNotice({}, home, has(legacy, "/h/.atrium")), null);
  assert.equal(legacyDataNotice({}, home, has()), null);
  assert.equal(
    legacyDataNotice({ ATRIUM_DATA: "/x" }, home, has(legacy)),
    null,
  );
});

test("服务信息回包判定：Atrium、旧版 Atrium、其他程序（t71）", () => {
  assert.deepEqual(
    classifyPortReply(200, '{"service":"atrium","data":"/d","version":"1"}'),
    { kind: "atrium", data: "/d" },
  );
  assert.deepEqual(classifyPortReply(200, '{"service":"atrium"}'), {
    kind: "atrium",
    data: null,
  });
  assert.deepEqual(
    classifyPortReply(401, '{"code":"auth_required","error":"x"}'),
    { kind: "atrium", data: null },
  );
  for (const [status, body] of [
    [200, "not-atrium"],
    [200, '{"service":"other","data":"/d"}'],
    [401, '{"code":"nope"}'],
    [404, "null"],
    [500, ""],
  ] as const)
    assert.deepEqual(classifyPortReply(status, body), { kind: "other" });
});

test("端口占用回执（t71）", () => {
  assert.equal(portTakenMessage(4310, { kind: "free" }, "/me"), null);
  assert.equal(
    portTakenMessage(4310, { kind: "atrium", data: "/me" }, "/me"),
    null,
    "就是本数据目录的服务：不算冲突",
  );
  assert.equal(
    portTakenMessage(4310, { kind: "atrium", data: "/other" }, "/me"),
    "端口 4310 已被另一份数据的 Atrium 占用：数据在 /other；要用它请设 ATRIUM_DATA=/other",
  );
  assert.match(
    portTakenMessage(4310, { kind: "atrium", data: null }, "/me")!,
    /端口 4310 已被另一个 Atrium 占用（版本较旧/,
  );
  assert.equal(
    portTakenMessage(4310, { kind: "other" }, "/me"),
    "端口 4310 已被其他程序占用；换端口请设 ATRIUM_PORT=<端口>",
  );
});

test("探测端口：空闲、其他程序、Atrium（t71）", async (t) => {
  const listen = async (handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    return (server.address() as { port: number }).port;
  };
  const other = await listen((_, reply) => reply.end("hello"));
  assert.deepEqual(await probePort(other), { kind: "other" });
  const atrium = await listen((request, reply) => {
    assert.equal(request.url, "/api/service/info");
    reply
      .writeHead(200, { "content-type": "application/json" })
      .end('{"service":"atrium","data":"/d"}');
  });
  assert.deepEqual(await probePort(atrium), { kind: "atrium", data: "/d" });
  // 关掉后同一端口应当空闲。
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const freePort = (closed.address() as { port: number }).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  assert.deepEqual(await probePort(freePort), { kind: "free" });
});
