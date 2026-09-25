import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import { LOCAL_USER } from "../shared/user.ts";
import {
  nextMessage,
  readBounds,
  sequence,
  waitOptions,
} from "../cli/wait-options.ts";

test("参数与最后一行是纯逻辑：非法输入被拒", () => {
  assert.equal(readBounds("0"), "?after=0");
  assert.equal(readBounds(undefined, "5"), "?before=5");
  assert.throws(() => readBounds("1", "2"), /不能同时/);
  for (const value of ["", "-1", "1.2", "01", "9007199254740992"])
    assert.throws(() => sequence(value, "--after"), /非负整数/);
  assert.throws(() => readBounds(undefined, "0"), /大于 0/);
  assert.deepEqual(waitOptions(undefined), { cursor: undefined, seconds: 300 });
  assert.throws(() => waitOptions("1", undefined, true), /不能与/);
  for (const value of ["0", "3601", "-1"])
    assert.throws(() => waitOptions(undefined, value), /--timeout/);
  assert.equal(
    nextMessage("继续等", "c15", 42),
    "继续等：atrium wait c15 --after 42",
  );
});

test("增量读取正序有界；等待通知、超时及客户端中断清理", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-wait-"));
  const { app, store, pendingWaits } = await createApp({
    auth: false,
    data,
    runtime: false,
    desktops: join(data, "desktops"),
    piHome: join(data, "pi"),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  const agent = store.createAgent("等候身份", data).agent;
  const chat = store.createChat("私聊", [agent.id], agent.id);
  const send = (body: string) =>
    store.send(LOCAL_USER, { chat_id: chat.id, body, mentions: [] });
  const first = send("先前");
  const page = (await fetch(
    `${origin}/chats/${chat.id}/messages?after=${first.id}`,
  ).then((r) => r.json())) as { items: { id: number }[] };
  assert.deepEqual(page.items, []);
  const pending = fetch(
    `${origin}/chats/${chat.id}/wait?after=${first.id}&timeout=2`,
  ).then((r) => r.json()) as Promise<{
    items: { id: number }[];
    timed_out: boolean;
  }>;
  await until(() => pendingWaits() === 1);
  const response = (await fetch(`${origin}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat.id, body: "回复", mentions: [] }),
  }).then((r) => r.json())) as { id: number };
  const got = await pending;
  assert.deepEqual(
    got.items.map((m) => m.id),
    [response.id],
  );
  assert.equal(got.timed_out, false);
  assert.equal(pendingWaits(), 0);
  const increment = (await fetch(
    `${origin}/chats/${chat.id}/messages?after=${first.id}`,
  ).then((r) => r.json())) as { items: { id: number }[] };
  assert.deepEqual(
    increment.items.map((m) => m.id),
    [response.id],
  );
  for (let i = 0; i < 52; i++) send(String(i));
  const bounded = (await fetch(
    `${origin}/chats/${chat.id}/messages?after=${first.id}`,
  ).then((r) => r.json())) as { items: { id: number }[]; has_more: boolean };
  assert.equal(bounded.items.length, 50);
  assert.equal(bounded.has_more, true);
  assert.equal(bounded.items[0]?.id, response.id);
  const next = (await fetch(
    `${origin}/chats/${chat.id}/messages?after=${bounded.items.at(-1)!.id}`,
  ).then((r) => r.json())) as { items: { id: number }[] };
  assert.equal(next.items.length, 3);
  const timeout = (await fetch(
    `${origin}/chats/${chat.id}/wait?timeout=1`,
  ).then((r) => r.json())) as { timed_out: boolean; after: number };
  assert.equal(timeout.timed_out, true);
  assert.equal(pendingWaits(), 0);
  const offline = (await fetch(
    `${origin}/agents/${agent.id}/wait?timeout=1`,
  ).then((r) => r.json())) as { status: string; finished_at: number | null };
  assert.deepEqual(offline, {
    status: "offline",
    finished_at: null,
    timed_out: false,
  });
  const abort = new AbortController();
  // Await response headers first: this guarantees the request reached the server before aborting.
  const responseStream = await fetch(
    `${origin}/chats/${chat.id}/wait?timeout=60`,
    { signal: abort.signal },
  );
  await until(() => pendingWaits() === 1);
  const body = responseStream.text();
  abort.abort();
  await assert.rejects(body, /abort/i);
  await until(() => pendingWaits() === 0);
  const invalid = await fetch(
    `${origin}/chats/${chat.id}/messages?after=1&before=2`,
  );
  assert.equal(invalid.status, 400);
});

test("busy 等当前轮结束；已空闲立即返回；断开的 idle 等待也移除", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-idle-"));
  const { app, store, runtimes, pendingWaits } = await createApp({
    auth: false,
    data,
    desktops: join(data, "desktops"),
    piHome: join(data, "pi"),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await app.close();
    rmSync(data, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  const agent = store.createAgent("忙碌身份", data).agent;
  const chat = store.createChat("测试", [agent.id], agent.id);
  type RuntimeConnection =
    NonNullable<typeof runtimes>["connections"] extends Map<string, infer T>
      ? T
      : never;
  const entry: RuntimeConnection = {
    connection: null as unknown as RuntimeConnection["connection"],
    info: {
      runtimeId: agent.id,
      generation: agent.id,
      sessionId: agent.id,
      pid: process.pid,
      ownerPid: null,
      sessionFile: null,
      cwd: data,
      mode: "rpc" as const,
      busy: true,
      model: "test",
    },
  };
  runtimes!.connections.set(agent.id, entry);
  const waiting = fetch(`${origin}/agents/${agent.id}/wait?timeout=3`).then(
    (r) => r.json(),
  ) as Promise<{
    status: string;
    finished_at: number | null;
    timed_out: boolean;
  }>;
  await until(() => pendingWaits() === 1);
  entry.info.busy = false;
  await fetch(`${origin}/chats/${chat.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned: true }),
  });
  const result = await waiting;
  assert.equal(result.status, "idle");
  assert.equal(result.timed_out, false);
  assert.equal(typeof result.finished_at, "number");
  assert.equal(pendingWaits(), 0);
  const already = (await fetch(
    `${origin}/agents/${agent.id}/wait?timeout=1`,
  ).then((r) => r.json())) as { finished_at: number | null };
  assert.equal(already.finished_at, null);
  entry.info.busy = true;
  const abort = new AbortController();
  const response = await fetch(`${origin}/agents/${agent.id}/wait?timeout=60`, {
    signal: abort.signal,
  });
  await until(() => pendingWaits() === 1);
  const body = response.text();
  abort.abort();
  await assert.rejects(body, /abort/i);
  await until(() => pendingWaits() === 0);
  runtimes!.connections.delete(agent.id);
  // 账号目录预加载在后台进行；结束前等它完成，避免测试关库时中断 worker。
  await fetch(`${origin}/providers`);
});

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("等待状态未按预期改变");
}
