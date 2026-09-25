import type { Store } from "./store.ts";
import { Problem } from "./store.ts";

export type RunnerOwnership = {
  agent_id: string;
  runner_id: string;
  generation: string;
  claimed_at: number;
};

export function ownerOf(store: Store, agentId: string) {
  return (
    store.one<RunnerOwnership>(
      "SELECT * FROM runner_ownership WHERE agent_id=?",
      agentId,
    ) ?? null
  );
}

/** Admin-only migration step. A runner token alone must never call this. */
export function claimRunner(
  store: Store,
  agentId: string,
  runnerId: string,
  generation: string,
) {
  store.agent(agentId);
  return store.transaction(() => {
    const owner = ownerOf(store, agentId);
    if (owner) {
      if (owner.runner_id === runnerId && owner.generation === generation)
        return owner;
      throw new Problem(
        409,
        "身份已有其他运行器归属，先确认旧实例停止后再交接",
      );
    }
    const row = {
      agent_id: agentId,
      runner_id: runnerId,
      generation,
      claimed_at: Date.now(),
    };
    store.run(
      "INSERT INTO runner_ownership(agent_id,runner_id,generation,claimed_at) VALUES(?,?,?,?)",
      row.agent_id,
      row.runner_id,
      row.generation,
      row.claimed_at,
    );
    return row;
  });
}

/** Only the control-plane that has confirmed the old ACP is stopped may release. */
export function releaseRunner(
  store: Store,
  agentId: string,
  runnerId: string,
  generation: string,
  confirmedStopped: boolean,
) {
  if (!confirmedStopped)
    throw new Problem(409, "未确认旧身份停止，不能释放运行器归属");
  return (
    store.run(
      "DELETE FROM runner_ownership WHERE agent_id=? AND runner_id=? AND generation=?",
      agentId,
      runnerId,
      generation,
    ).changes === 1
  );
}

export type RecoveryStatus = "exited" | "alive" | "unknown";

/** Authenticated same-runner report; old and new generations are compared inside one transaction. */
export function rebindStopped(
  store: Store,
  runnerId: string,
  oldGeneration: string | null,
  newGeneration: string,
  statuses: Record<string, RecoveryStatus>,
  defaultStatus: RecoveryStatus,
) {
  return store.transaction(() => {
    const rows = store.all<RunnerOwnership>(
      "SELECT * FROM runner_ownership WHERE runner_id=?",
      runnerId,
    );
    const rebound: string[] = [];
    const locked: Record<string, "alive" | "unknown"> = {};
    for (const row of rows) {
      if (row.generation === newGeneration) continue;
      const status =
        row.generation === oldGeneration
          ? (statuses[row.agent_id] ?? defaultStatus)
          : "unknown";
      if (status !== "exited") {
        locked[row.agent_id] = status;
        continue;
      }
      if (
        store.run(
          "UPDATE runner_ownership SET generation=?,claimed_at=? WHERE agent_id=? AND runner_id=? AND generation=?",
          newGeneration,
          Date.now(),
          row.agent_id,
          runnerId,
          row.generation,
        ).changes !== 1
      )
        throw new Error("身份运行器归属已变化");
      rebound.push(row.agent_id);
    }
    return { rebound, locked, allRecovered: !Object.keys(locked).length };
  });
}

export function assertRunnerOwner(
  store: Store,
  agentId: string,
  runnerId: string,
  generation: string,
) {
  const owner = ownerOf(store, agentId);
  if (owner?.runner_id !== runnerId || owner.generation !== generation)
    throw new Problem(403, "该运行器没有此身份的运行归属");
}
