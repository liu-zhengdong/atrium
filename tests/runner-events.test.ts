import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { RunnerEvents } from "../server/runner-events.ts";

const runtimeId = randomUUID();
const generation = randomUUID();
const sessionId = randomUUID();
const page = (seqs: number[], gap = false) => ({
  runtimeId,
  generation,
  sessionId,
  items: seqs.map((seq) => ({
    seq,
    at: seq,
    kind: "message" as const,
    text: "x".repeat(32),
  })),
  nextAfter: seqs.at(-1) ?? 0,
  hasMore: false,
  gap,
});

test("events survive a Web disconnect in bounded memory until service advances cursor", () => {
  const events = new RunnerEvents(2000);
  events.add(page([1, 2]));
  assert.deepEqual(
    events.page(runtimeId, generation, sessionId, 0, 1).items.map((x) => x.seq),
    [1],
  );
  // No ACK yet: the same cursor can fetch the event again after a reconnect.
  assert.deepEqual(
    events.page(runtimeId, generation, sessionId, 0, 1).items.map((x) => x.seq),
    [1],
  );
  events.add(page([3, 4]));
  const recovered = events.page(runtimeId, generation, sessionId, 1, 50);
  assert.deepEqual(
    recovered.items.map((x) => x.seq),
    [2, 3, 4],
  );
  assert.equal(recovered.gap, false);
  assert.equal(recovered.nextAfter, 4);
  assert.equal(
    events.page(runtimeId, generation, sessionId, 4, 50).items.length,
    0,
  );
});

test("Pi gap and runner buffer overflow report missing events rather than inventing completion", () => {
  const events = new RunnerEvents(130);
  events.add(page([1, 2, 3, 4]));
  const lost = events.page(runtimeId, generation, sessionId, 0, 10);
  assert.equal(lost.gap, true);
  assert.ok(lost.items[0].seq > 1);
  const piGap = new RunnerEvents(3000);
  piGap.add(page([1]));
  piGap.add(page([4], true));
  const discontinuous = piGap.page(runtimeId, generation, sessionId, 0, 10);
  assert.deepEqual(
    discontinuous.items.map((x) => x.seq),
    [1, 4],
  );
  assert.equal(discontinuous.gap, true);
  assert.throws(
    () => piGap.page(runtimeId, randomUUID(), sessionId, 0, 10),
    /会话未找到/,
  );
});
