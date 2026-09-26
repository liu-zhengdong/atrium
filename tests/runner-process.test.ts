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
import { RunnerDaemon } from "../server/runner-daemon.ts";

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

test("容器 journal 在创建前记意图；未知、活跃或错代旧写者不能产生第二写者", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-runner-container-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "r1.state.json");
  const containerId = "a".repeat(64);
  const imageId = `sha256:${"b".repeat(64)}`;
  const owners: string[] = [];
  let verdict: "alive" | "unknown" | "exited" = "unknown";
  const probe = (owner: {
    containerId: string;
    engineId: string;
    imageId: string;
    identityId: string;
    generation: string;
  }) => {
    owners.push(`${owner.identityId}:${owner.generation}:${owner.containerId}`);
    assert.equal(owner.engineId, "engine-1");
    assert.equal(owner.imageId, imageId);
    return verdict;
  };
  const first = new RunnerJournal(file, "gen-1", probe);
  first.containerStarting("a1", "engine-1", imageId);
  assert.match(readFileSync(file, "utf8"), /"containerId":null/);
  first.close();
  const uncertain = new RunnerJournal(file, "gen-2", probe);
  assert.equal(uncertain.verdict("a1"), "unknown");
  assert.equal(await uncertain.reclaim("a1", true), "unknown");
  assert.throws(
    () => uncertain.containerStarting("a1", "engine-1", imageId),
    /旧身份写者/,
  );
  uncertain.clearPrevious();
  assert.equal(uncertain.oldGeneration(), "gen-1");
  uncertain.close();

  // Crash after Docker create and before 'running': stored ID still protects it.
  const createdFile = join(dir, "created.state.json");
  const created = new RunnerJournal(createdFile, "generation-create", probe);
  created.containerStarting("a1", "engine-1", imageId);
  created.containerCreated("a1", containerId);
  created.close();
  verdict = "alive";
  const afterCreate = new RunnerJournal(
    createdFile,
    "generation-after-create",
    probe,
  );
  assert.equal(afterCreate.verdict("a1"), "alive");
  assert.throws(
    () => afterCreate.containerStarting("a1", "engine-1", imageId),
    /旧身份写者/,
  );
  afterCreate.close();
  const daemon = new RunnerDaemon(
    "ws://127.0.0.1:19998/runner/v1",
    "fake",
    { ATRIUM_PI_ACP_ENTRY: "/nonexistent" },
    createdFile,
  );
  try {
    await assert.rejects(
      () =>
        (
          daemon as unknown as {
            handleAcp(
              id: string,
              method: string,
              params: unknown,
            ): Promise<unknown>;
          }
        ).handleAcp("a1", "_pi/identity/start", { identityId: "a1" }),
      /容器身份不能使用宿主 Pi 通路/,
    );
    await assert.rejects(
      () =>
        (
          daemon as unknown as {
            handle(method: string, params: unknown): Promise<unknown>;
          }
        ).handle("mcp.url", { agentId: "a1" }),
      /容器身份不能使用宿主 MCP 通路/,
    );
    const drain = daemon as unknown as {
      draining: Set<string>;
      drainStatus(id: string): Promise<{ drained: boolean; busy: string[] }>;
    };
    drain.draining.add("a1");
    assert.deepEqual(await drain.drainStatus("a1"), {
      drained: false,
      busy: ["容器写者未接入排空，不能按宿主空闲判断"],
    });
  } finally {
    daemon.close();
  }

  // A separate journal records Docker create before start, then the live writer.
  const recordedFile = join(dir, "r2.state.json");
  const recorded = new RunnerJournal(recordedFile, "gen-1", probe);
  recorded.containerStarting("a1", "engine-1", imageId);
  recorded.containerCreated("a1", containerId);
  verdict = "alive";
  recorded.containerRunning("a1");
  recorded.close();
  const next = new RunnerJournal(recordedFile, "gen-3", probe);
  assert.equal(next.verdict("a1"), "alive");
  assert.equal(
    await next.reclaim("a1", true),
    "alive",
    "operator assertion cannot replace Docker proof",
  );
  assert.throws(
    () => next.containerStarting("a1", "engine-1", imageId),
    /旧身份写者/,
  );
  verdict = "unknown";
  assert.equal(next.verdict("a1"), "unknown");
  assert.throws(
    () => next.containerStarting("a1", "engine-1", imageId),
    /旧身份写者/,
  );
  next.clearPrevious();
  assert.equal(next.oldGeneration(), "gen-1");
  verdict = "exited";
  assert.equal(next.verdict("a1"), "exited");
  next.containerStarting("a1", "engine-1", imageId);
  assert.throws(() => next.containerCreated("a1", "bad-id"));
  next.containerCreated("a1", containerId);
  assert.throws(() => next.starting("a1"), /已有容器写者/);
  assert.throws(() => next.running("a1", process.pid), /已有容器写者/);
  assert.throws(() => next.containerRunning("a1"), /未证实/);
  assert.throws(() => next.stopped("a1"), /容器需先确认/);
  verdict = "alive";
  next.containerRunning("a1");
  assert.throws(() => next.containerStopped("a1"), /未证实退出/);
  verdict = "exited";
  next.containerStopped("a1");
  assert.equal(owners.at(-1), `a1:gen-3:${containerId}`);
  next.close();
});
