import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertRunnerOwner,
  claimRunner,
  ownerOf,
  rebindStopped,
  releaseRunner,
} from "../server/runner-ownership.ts";
import { Store } from "../server/store.ts";
import { RunnerJournal } from "../server/runner-process.ts";

test("identity owner is durable and cannot be claimed by a second runner or generation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-runner-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "store.sqlite");
  let store = new Store(path);
  const id = store.createAgent("归属测试", root).agent.id;
  const claimed = claimRunner(store, id, "r1", "generation-1");
  assert.equal(
    claimRunner(store, id, "r1", "generation-1").claimed_at,
    claimed.claimed_at,
  );
  store.close();
  store = new Store(path);
  try {
    assert.equal(ownerOf(store, id)?.runner_id, "r1");
    assert.throws(
      () => claimRunner(store, id, "r2", "generation-2"),
      /其他运行器归属/,
    );
    assert.throws(
      () => claimRunner(store, id, "r1", "generation-2"),
      /其他运行器归属/,
    );
    assert.throws(
      () => assertRunnerOwner(store, id, "r2", "generation-1"),
      /没有此身份/,
    );
    assert.throws(
      () => assertRunnerOwner(store, id, "r1", "generation-2"),
      /没有此身份/,
    );
    assertRunnerOwner(store, id, "r1", "generation-1");
    assert.throws(
      () => releaseRunner(store, id, "r1", "generation-1", false),
      /确认旧身份停止/,
    );
    assert.equal(releaseRunner(store, id, "r2", "generation-1", true), false);
    assert.equal(releaseRunner(store, id, "r1", "generation-1", true), true);
    assert.equal(claimRunner(store, id, "r2", "generation-2").runner_id, "r2");
  } finally {
    store.close();
  }
});

test("same runner rebinds only verified exited identities, never another runner's claim", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-runner-rebind-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.sqlite"));
  t.after(() => store.close());
  const a1 = store.createAgent("a1 退出", root).agent.id;
  const a2 = store.createAgent("a2 托孤", root).agent.id;
  claimRunner(store, a1, "r1", "old-gen");
  claimRunner(store, a2, "r1", "old-gen");
  const other = rebindStopped(
    store,
    "r2",
    "old-gen",
    "new-gen",
    { [a1]: "exited" },
    "unknown",
  );
  assert.deepEqual(other.rebound, []);
  assert.equal(ownerOf(store, a1)?.generation, "old-gen");
  const result = rebindStopped(
    store,
    "r1",
    "old-gen",
    "new-gen",
    {
      [a1]: "exited",
      [a2]: "alive",
    },
    "unknown",
  );
  assert.deepEqual(result.rebound, [a1]);
  assert.equal(result.locked[a2], "alive");
  assert.equal(ownerOf(store, a1)?.generation, "new-gen");
  assert.equal(ownerOf(store, a2)?.generation, "old-gen");
  const missing = rebindStopped(store, "r1", null, "third-gen", {}, "unknown");
  assert.equal(missing.locked[a1], "unknown");
  assert.equal(missing.locked[a2], "unknown");
  assert.equal(ownerOf(store, a1)?.generation, "new-gen");
});

test("runner 重启以容器 inspect 判定旧写者；未证实退出不重绑 Web owner", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-container-rebind-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.sqlite"));
  t.after(() => store.close());
  const agentId = store.createAgent("旧容器身份", root).agent.id;
  const state = join(root, "runner.json");
  let observed: "alive" | "unknown" | "exited" = "alive";
  const probe = () => observed;
  const before = new RunnerJournal(state, "generation-1", probe);
  claimRunner(store, agentId, "r1", "generation-1");
  before.containerStarting(agentId, "engine-1", `sha256:${"b".repeat(64)}`);
  before.containerCreated(agentId, "a".repeat(64));
  before.containerRunning(agentId);
  before.close();
  const after = new RunnerJournal(state, "generation-2", probe);
  t.after(() => after.close());
  const report = () =>
    rebindStopped(
      store,
      "r1",
      after.oldGeneration(),
      "generation-2",
      Object.fromEntries(
        after.priorAgents().map((id) => [id, after.verdict(id)]),
      ),
      after.verdict("__unrecorded__"),
    );
  assert.equal(report().locked[agentId], "alive");
  assert.equal(ownerOf(store, agentId)?.generation, "generation-1");
  observed = "unknown";
  assert.equal(report().locked[agentId], "unknown");
  assert.equal(ownerOf(store, agentId)?.generation, "generation-1");
  after.clearPrevious();
  assert.equal(after.oldGeneration(), "generation-1");
  observed = "exited";
  assert.deepEqual(report().rebound, [agentId]);
  assert.equal(ownerOf(store, agentId)?.generation, "generation-2");
  after.clearPrevious();
  assert.equal(after.oldGeneration(), null);
});
