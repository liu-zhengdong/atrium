import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store.ts";
import { createApp } from "../server/legacy-app.ts";

test("汇报链可清空、拒绝环/已删除对象，并在删除上级后回退用户", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const a = store.createAgent("甲", tmpdir()).agent;
  const b = store.createAgent("乙", tmpdir()).agent;
  const c = store.createAgent("丙", tmpdir()).agent;
  assert.equal(a.reports_to, null);
  assert.deepEqual(store.setReportsTo(a.id, b.ref), {
    reports_to: { ref: b.ref, name: b.name },
  });
  store.setReportsTo(b.id, c.ref);
  assert.throws(() => store.setReportsTo(c.id, a.ref), /不能形成环/);
  assert.throws(() => store.setReportsTo(a.id, a.ref), /不能形成环/);
  assert.deepEqual(store.agent(a.id).reports_to, { ref: b.ref, name: b.name });
  assert.deepEqual(store.setReportsTo(a.id, "u1"), { reports_to: null });
  store.setReportsTo(a.id, b.ref);
  store.deleteAgent(b.id);
  assert.equal(store.agent(a.id).reports_to, null);
  assert.throws(() => store.setReportsTo(a.id, b.ref), /不存在/);
  assert.equal(store.agent(c.id).reports_to, null);
});

test("用户端 PATCH 只接受短号或 u1/null；overview 读回并拒绝非法值", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-reports-to-"));
  const { app, store } = await createApp({
    data: join(root, "data"),
    runtime: false,
    auth: false,
  });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const a = store.createAgent("甲", root).agent;
  const b = store.createAgent("乙", root).agent;
  const path = `/api/agents/${a.id}/reports-to`;
  const changed = await app.inject({
    method: "PATCH",
    url: path,
    payload: { reports_to: b.ref },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual(changed.json(), {
    reports_to: { ref: b.ref, name: b.name },
  });
  const overview = await app.inject({ method: "GET", url: "/api/overview" });
  assert.deepEqual(
    overview.json().agents.find((agent: { id: string }) => agent.id === a.id)
      .reports_to,
    changed.json().reports_to,
  );
  for (const reports_to of ["unknown", "none", "", 4]) {
    const rejected = await app.inject({
      method: "PATCH",
      url: path,
      payload: { reports_to },
    });
    assert.equal(
      rejected.statusCode,
      400,
      `${JSON.stringify(reports_to)}: ${rejected.body}`,
    );
  }
  const cleared = await app.inject({
    method: "PATCH",
    url: path,
    payload: { reports_to: null },
  });
  assert.deepEqual(cleared.json(), { reports_to: null });
});
