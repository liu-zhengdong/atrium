import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  ownedContainerVerdict,
  type ContainerOwner,
} from "./container-writer-proof.ts";

const processRef = z.object({
  pid: z.number().int().positive(),
  started: z.string().min(1),
});
export type ProcessRef = z.infer<typeof processRef>;
export type ProcessVerdict = "exited" | "alive" | "unknown";
const hostState = z.object({
  kind: z.literal("host").optional(), // absent in existing journals
  phase: z.enum(["starting", "running"]),
  pi: processRef.nullable(),
});
const containerState = z
  .object({
    kind: z.literal("container"),
    phase: z.enum(["starting", "running"]),
    containerId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    engineId: z.string().min(1).max(128),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const agentState = z.union([containerState, hostState]);
const snapshot = z.object({
  generation: z.string(),
  daemon: processRef.nullable(),
  acp: processRef.nullable(),
  agents: z.record(z.string(), agentState),
});
type Snapshot = z.infer<typeof snapshot>;
const journalSchema = z.object({
  current: snapshot,
  // Keep every unresolved generation: overwriting one could hide a live Pi.
  previous: z.union([z.array(snapshot), snapshot.nullable()]),
});

/** A missing PID has exited; probe errors are UNKNOWN, never evidence of exit. */
export function processStart(pid: number): string | null | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2000,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    }).trim();
    return output || undefined;
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    // ps returns 1 with no diagnostic only when the PID does not exist.
    if (
      failure.status === 1 &&
      !failure.stdout?.trim() &&
      !failure.stderr?.trim()
    )
      return null;
    return undefined;
  }
}
export function fingerprint(pid: number): ProcessRef | null {
  const started = processStart(pid);
  return started ? { pid, started } : null;
}
export function processVerdict(
  ref: ProcessRef | null,
  probe = processStart,
): ProcessVerdict {
  if (!ref) return "unknown";
  const started = probe(ref.pid);
  if (started === undefined) return "unknown";
  return started === ref.started ? "alive" : "exited";
}
export function priorVerdict(
  prior: Snapshot | null,
  agentId: string,
  probe = processStart,
  containerProbe = ownedContainerVerdict,
): ProcessVerdict {
  if (!prior) return "unknown";
  const child = prior.agents[agentId];
  // Other identities may still run in the old gateway, but this writer must
  // have exited. A PID never certifies the state of a Docker container.
  if (child) {
    if (child.kind === "container") {
      if (!child.containerId) return "unknown";
      return containerProbe({
        containerId: child.containerId,
        engineId: child.engineId,
        imageId: child.imageId,
        identityId: agentId,
        generation: prior.generation,
      });
    }
    return child.phase === "running"
      ? processVerdict(child.pi, probe)
      : "unknown";
  }
  // A claim made before its first start has no child. Check both old owners:
  // otherwise an old gateway could still start it after a disconnected socket.
  if (!prior.daemon || !prior.acp) return "unknown";
  const verdicts = [prior.daemon, prior.acp].map((ref) =>
    processVerdict(ref, probe),
  );
  if (verdicts.includes("alive")) return "alive";
  return verdicts.includes("unknown") ? "unknown" : "exited";
}

/** Atomic local-only journal; an OS-held SQLite lock excludes a second daemon.
 * The lock is released on process death, independent of PID reuse. */
export class RunnerJournal {
  private prior: Snapshot[];
  get previous() {
    return this.prior;
  }
  private current: Snapshot;
  private lock: DatabaseSync;
  private closed = false;
  constructor(
    private file: string,
    generation: string,
    private containerProbe: (
      owner: ContainerOwner,
    ) => ProcessVerdict = ownedContainerVerdict,
  ) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const lockFile = `${file}.lock.sqlite`;
    const lock = new DatabaseSync(lockFile, { timeout: 0 });
    try {
      lock.exec("BEGIN EXCLUSIVE");
      chmodSync(lockFile, 0o600);
    } catch {
      lock.close();
      throw new Error(
        "运行器已在运行；请先停止旧运行器，不能同时启动同一个运行器",
      );
    }
    this.lock = lock;
    let previous: Snapshot[] = [];
    try {
      try {
        const parsed = journalSchema.parse(
          JSON.parse(readFileSync(file, "utf8")),
        );
        previous = [
          ...(Array.isArray(parsed.previous)
            ? parsed.previous
            : parsed.previous
              ? [parsed.previous]
              : []),
          parsed.current,
        ];
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )) {
          const quarantine = `${file}.invalid-${Date.now()}`;
          try {
            renameSync(file, quarantine);
          } catch {
            /* leave original for inspection */
          }
          console.error(
            `运行器状态文件不可读，旧身份将锁住；原件保留在 ${quarantine}`,
          );
        }
      }
      this.prior = previous;
      this.current = {
        generation,
        daemon: fingerprint(process.pid),
        acp: null,
        agents: {},
      };
      this.persist();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.lock.exec("ROLLBACK");
    this.lock.close();
  }
  private persist() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({ current: this.current, previous: this.prior }),
      { mode: 0o600 },
    );
    renameSync(temp, this.file);
  }
  acp(pid: number) {
    this.current.acp = fingerprint(pid);
    this.persist();
  }
  starting(agentId: string) {
    if (this.current.agents[agentId]?.kind === "container")
      throw new Error("此身份已有容器写者记录");
    this.current.agents[agentId] = { phase: "starting", pi: null };
    this.persist();
  }
  running(agentId: string, pid: number) {
    if (this.current.agents[agentId]?.kind === "container")
      throw new Error("此身份已有容器写者记录");
    this.current.agents[agentId] = { phase: "running", pi: fingerprint(pid) };
    this.persist();
  }
  /** Persist intent before Docker create. Until the ID is recorded, a crash
   * leaves this identity locked rather than guessing whether a writer exists. */
  containerStarting(agentId: string, engineId: string, imageId: string) {
    if (this.current.agents[agentId])
      throw new Error("此身份已有运行中的写者记录");
    if (this.prior.length && this.verdict(agentId) !== "exited")
      throw new Error("旧身份写者未证实退出，不能创建新容器");
    this.current.agents[agentId] = containerState.parse({
      kind: "container",
      phase: "starting",
      containerId: null,
      engineId,
      imageId,
    });
    this.persist();
  }
  /** Called immediately after create and before start; never infer ID from PID. */
  containerCreated(agentId: string, containerId: string) {
    const child = this.current.agents[agentId];
    if (
      child?.kind !== "container" ||
      child.phase !== "starting" ||
      child.containerId
    )
      throw new Error("容器启动顺序不合法");
    child.containerId = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(containerId);
    this.persist();
  }
  containerRunning(agentId: string) {
    const child = this.current.agents[agentId];
    if (
      child?.kind !== "container" ||
      !child.containerId ||
      child.phase !== "starting"
    )
      throw new Error("容器启动顺序不合法");
    if (this.containerVerdict(agentId, child) !== "alive")
      throw new Error("容器未证实为本身份的运行中写者");
    child.phase = "running";
    this.persist();
  }
  containerStopped(agentId: string) {
    const child = this.current.agents[agentId];
    if (
      child?.kind !== "container" ||
      this.containerVerdict(agentId, child) !== "exited"
    )
      throw new Error("容器未证实退出，不能清除写者记录");
    delete this.current.agents[agentId];
    this.persist();
  }
  private containerVerdict(
    agentId: string,
    child: z.infer<typeof containerState>,
  ) {
    if (!child.containerId) return "unknown";
    return this.containerProbe({
      containerId: child.containerId,
      engineId: child.engineId,
      imageId: child.imageId,
      identityId: agentId,
      generation: this.current.generation,
    });
  }
  stopped(agentId: string) {
    if (this.current.agents[agentId]?.kind === "container")
      throw new Error("容器需先确认退出，不能清除写者记录");
    delete this.current.agents[agentId];
    this.persist();
  }
  hasAgent(agentId: string) {
    return Object.hasOwn(this.current.agents, agentId);
  }
  hasContainerRecord(agentId: string): boolean {
    return (
      this.current.agents[agentId]?.kind === "container" ||
      this.prior.some((entry) => entry.agents[agentId]?.kind === "container")
    );
  }
  verdict(agentId: string): ProcessVerdict {
    if (!this.prior.length) return "unknown";
    const verdicts = this.prior.map((entry) =>
      priorVerdict(entry, agentId, processStart, this.containerProbe),
    );
    if (verdicts.includes("alive")) return "alive";
    return verdicts.includes("unknown") ? "unknown" : "exited";
  }
  oldGeneration() {
    return this.prior.at(-1)?.generation ?? null;
  }
  priorAgents() {
    return [
      ...new Set(this.prior.flatMap((entry) => Object.keys(entry.agents))),
    ];
  }
  /** Keep any older proof until no Web owner needs it AND every tracked process exited. */
  clearPrevious() {
    const ids = this.priorAgents();
    if (ids.some((id) => this.verdict(id) !== "exited")) return;
    this.prior = [];
    this.persist();
  }
  /** Only signal a Pi whose PID and start time still match our local journal. */
  async reclaim(
    agentId: string,
    confirmStopped: boolean,
  ): Promise<ProcessVerdict> {
    const verdict = this.verdict(agentId);
    if (verdict === "exited") return verdict;
    // Only a same-engine, label-bound Docker inspection can clear a container
    // writer. An operator assertion and SIGTERM to a host PID cannot do so.
    if (this.prior.some((entry) => entry.agents[agentId]?.kind === "container"))
      return verdict;
    const live = this.prior.flatMap((entry) => {
      const child = entry.agents[agentId];
      return child?.kind !== "container" &&
        child?.phase === "running" &&
        child.pi &&
        processVerdict(child.pi) === "alive"
        ? [child.pi]
        : [];
    });
    if (live.length) {
      if (live.some((ref) => ref.pid === process.pid)) return "alive";
      for (const ref of live) {
        if (processVerdict(ref) !== "alive") return this.verdict(agentId);
        try {
          process.kill(ref.pid, "SIGTERM");
        } catch {
          return this.verdict(agentId);
        }
      }
      for (let attempt = 0; attempt < 30; attempt++) {
        if (this.verdict(agentId) === "exited") return "exited";
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return this.verdict(agentId);
    }
    // Missing journal or a crash between spawn and status cannot prove exit.
    // Only an explicit operator assertion (after inspecting the host) unlocks it.
    return confirmStopped && verdict !== "alive" ? "exited" : verdict;
  }
}
