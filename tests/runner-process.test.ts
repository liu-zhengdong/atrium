import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  RunnerJournal,
  priorVerdict,
  processStart,
  processVerdict,
} from "../server/runner-process.ts";

const ref = (pid: number, started: string) => ({ pid, started });
const prior = (pi: ReturnType<typeof ref> | null) => ({
  generation: "old",
  daemon: ref(10, "old-daemon"),
  acp: ref(11, "old-acp"),
  agents: { a1: { phase: "running" as const, pi } },
});

test("local PID proof distinguishes reuse, living orphan and uncertain state", () => {
  assert.equal(
    priorVerdict(prior(ref(100, "old-pi")), "a1", () => "new-pi"),
    "exited",
  );
  assert.equal(
    priorVerdict(prior(ref(100, "old-pi")), "a1", () => "old-pi"),
    "alive",
  );
  assert.equal(
    priorVerdict(prior(ref(100, "old-pi")), "a1", () => undefined),
    "unknown",
  );
  assert.equal(
    priorVerdict(prior(null), "a1", () => null),
    "unknown",
  );
  assert.equal(
    priorVerdict(null, "a1", () => null),
    "unknown",
  );
  assert.equal(
    priorVerdict({ ...prior(null), agents: {} }, "a1", () => null),
    "exited",
  );
  assert.equal(
    priorVerdict({ ...prior(null), agents: {} }, "a1", (pid) =>
      pid === 11 ? "old-acp" : null,
    ),
    "alive",
  );
  assert.equal(
    processVerdict(ref(100, "old"), () => null),
    "exited",
  );
  assert.equal(typeof processStart(process.pid), "string");
});

test("runner state persists without credentials; missing or broken state is locked", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-runner-process-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "r1.state.json");
  const first = new RunnerJournal(file, "generation-1");
  assert.equal(first.verdict("a1"), "unknown");
  first.acp(process.pid);
  first.starting("a1");
  assert.throws(() => new RunnerJournal(file, "duplicate"), /运行器已在运行/);
  first.close();
  const second = new RunnerJournal(file, "generation-2");
  assert.equal(second.oldGeneration(), "generation-1");
  assert.equal(second.verdict("a1"), "unknown");
  assert.ok(!readFileSync(file, "utf8").includes("Bearer "));
  second.clearPrevious();
  // A starting child has uncertain outcome: never discard its generation.
  assert.equal(second.oldGeneration(), "generation-1");
  second.close();
  writeFileSync(file, "{ broken state", { mode: 0o600 });
  const third = new RunnerJournal(file, "generation-3");
  assert.equal(third.verdict("a1"), "unknown");
  third.close();
});

test("repeated restart retains newer-generation Pi evidence while an older orphan remains", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-runner-generations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "r1.state.json");
  const first = new RunnerJournal(file, "generation-1");
  first.running("a1", process.pid);
  first.close();
  // Simulate the prior daemon and gateway exiting; a2 starts in the next generation.
  const old = JSON.parse(readFileSync(file, "utf8"));
  old.current.daemon = { pid: 99998, started: "old" };
  old.current.acp = { pid: 99997, started: "old" };
  writeFileSync(file, JSON.stringify(old), { mode: 0o600 });
  const second = new RunnerJournal(file, "generation-2");
  second.running("a2", process.pid);
  second.close();
  const third = new RunnerJournal(file, "generation-3");
  assert.equal(third.oldGeneration(), "generation-2");
  assert.equal(third.verdict("a2"), "alive");
  assert.equal(third.verdict("a1"), "alive");
  third.close();
});
