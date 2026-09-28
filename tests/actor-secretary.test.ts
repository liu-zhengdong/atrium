import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveActor } from "../server/actor.ts";
import { createApp } from "../server/app.ts";
import { asVerdict } from "../server/leaders/scope.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode, editDoc } from "../server/org/write.ts";
import { history } from "../server/org/read.ts";
import { actsForUser } from "../shared/user.ts";
import { defaultActor } from "../cli/worker-guard.ts";
import { removeTemp } from "./temp-dir.ts";

test("以谁的名义：u1、secretary（秘书）与 leader；权限上秘书同用户", () => {
  const db = new DatabaseSync(":memory:");
  ensureOrgTables(db);
  addNode(db, { slug: "org", kind: "org", name: "组织", reason: "建" }, "u1");
  addNode(
    db,
    {
      parent: "o1",
      slug: "cli",
      kind: "project",
      name: "命令行",
      leader: "a1",
      reason: "建",
    },
    "u1",
  );
  assert.equal(resolveActor(db), "u1");
  assert.equal(resolveActor(db, " "), "u1");
  assert.equal(resolveActor(db, "secretary"), "secretary");
  assert.equal(resolveActor(db, "秘书"), "secretary");
  assert.equal(resolveActor(db, "a1"), "a1");
  assert.throws(() => resolveActor(db, "a9"), /a9 不是任何组织节点的 leader/);
  for (const bad of ["boss", "u2", "Secretary", "../u1"])
    assert.throws(
      () => resolveActor(db, bad),
      /--as 应为 u1、secretary 或组织节点 leader 的短号/,
      bad,
    );
  assert.equal(actsForUser("u1"), true);
  assert.equal(actsForUser("secretary"), true);
  assert.equal(actsForUser("a1"), false);

  // 根章程：秘书改得动、修订记秘书；leader 仍改不动。
  editDoc(
    db,
    "o1",
    "charter",
    { fields: {}, body: "秘书起草", reason: "起草" },
    "secretary",
  );
  assert.throws(
    () =>
      editDoc(
        db,
        "o1",
        "charter",
        { fields: {}, body: "改", reason: "改" },
        "a1",
      ),
    /无权限/,
  );
  const items = history(db, "o1", { target: "charter" }).items!;
  assert.equal(items[0]!.author, "secretary");
  db.close();
});

test("leader 令牌不能以秘书名义；命令行缺省名义只在秘书会话里带", () => {
  assert.match(asVerdict("a1", "secretary")!, /只能用自己（a1）/);
  assert.equal(asVerdict("a1", undefined), null);
  assert.equal(defaultActor({}), undefined);
  assert.equal(defaultActor({ ATRIUM_AS: " secretary " }), "secretary");
  assert.equal(
    defaultActor({ ATRIUM_AS: "secretary", ATRIUM_LEADER_TOKEN: "a1.x" }),
    undefined,
  );
});

test("服务：?as=secretary 改档案、章程、专员，修订如实记秘书；不带仍记 u1", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-actor-"));
  t.after(() => removeTemp(data));
  const { app } = await createApp({
    data,
    auth: false,
    tasks: {
      workersDir: join(data, "no-workers"),
      pace: async () => undefined,
      usagePace: async () => undefined,
    },
  });
  t.after(() => app.close());
  const call = async (
    method: "GET" | "POST" | "PUT" | "PATCH",
    url: string,
    payload?: object,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: { host: "127.0.0.1" },
      ...(payload ? { payload } : {}),
    });
    return {
      status: response.statusCode,
      body: response.json() as Record<string, any>,
    };
  };
  const root = await call("POST", "/api/org/nodes?as=secretary", {
    slug: "org",
    kind: "org",
    name: "组织",
    reason: "建",
  });
  assert.equal(root.status, 201, JSON.stringify(root.body));
  const charter = await call(
    "PUT",
    "/api/org/nodes/o1/docs/charter?as=secretary",
    {
      source:
        "---\nbudget:\n  quota_reserve_percent: 20\n  money: 0\n---\n根章程\n",
      reason: "用户 09-28 确认",
    },
  );
  assert.equal(charter.status, 200, JSON.stringify(charter.body));
  const revisions = await call("GET", "/api/org/nodes/o1/history");
  assert.deepEqual(
    revisions.body.items.map((r: { author: string }) => r.author),
    ["secretary", "secretary"],
  );

  const profile = await call(
    "PUT",
    "/api/workers/profiles/harness/codex?as=secretary",
    { set: { trust: "medium" }, reason: "秘书调" },
  );
  assert.equal(profile.status, 200, JSON.stringify(profile.body));
  const mine = await call("PUT", "/api/workers/profiles/harness/codex", {
    set: { trust: "high" },
    reason: "用户自己调",
  });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const shown = await call("GET", "/api/workers/profiles/harness/codex");
  assert.deepEqual(
    shown.body.history.map((h: { author: string }) => h.author),
    ["u1", "secretary"],
  );

  const bad = await call("PUT", "/api/workers/profiles/harness/codex?as=boss", {
    set: { trust: "low" },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /--as 应为 u1、secretary/);
});
