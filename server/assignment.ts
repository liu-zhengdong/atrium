import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Problem, type Store } from "./store.ts";

export const UNASSIGNED = "未分配账号";

/** An assignment is the only authority to launch a managed identity. */
export function hasAssignment(store: Store, id: string): boolean {
  return !!store.one(
    "SELECT 1 FROM account_assignments WHERE agent_id=? LIMIT 1",
    id,
  );
}

export function requireAssignment(store: Store, id: string) {
  if (!hasAssignment(store, id))
    throw new Problem(
      409,
      `${UNASSIGNED}；先执行 atrium assign ${store.agent(id).ref} <账号短号>`,
      "unassigned_account",
    );
}

/** Retire legacy shared links without following them or touching their targets. */
export function removeSharedLinks(store: Store) {
  for (const agent of store.agents()) {
    if (!agent.agent_directory) continue;
    const file = join(agent.agent_directory, "auth.json");
    try {
      // The legacy template path may have changed since the link was made.
      // Only unlink the identity's entry; never read or touch its target.
      if (lstatSync(file).isSymbolicLink()) unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
