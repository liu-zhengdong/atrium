import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Problem, type Store } from "./store.ts";
import { readIdentityModel } from "./profile.ts";

export const UNASSIGNED = "未分配账号";

/** An assignment is the only authority to launch a managed identity. */
export function hasAssignment(store: Store, id: string): boolean {
  return !!store.one(
    "SELECT 1 FROM account_assignments WHERE agent_id=? LIMIT 1",
    id,
  );
}

type AvailableAccount = { id: string; provider: string; status: string };

/** Recommend only a usable account for the identity's configured model provider. */
export function assignmentCommand(
  store: Store,
  id: string,
  accounts: AvailableAccount[],
): string | null {
  const agent = store.agent(id);
  let provider: string | undefined;
  try {
    provider = agent.agent_directory
      ? (readIdentityModel(agent.agent_directory)?.provider ?? undefined)
      : undefined;
  } catch {
    // A broken model file must not hide the rest of the preflight report.
    return null;
  }
  const account = accounts.find(
    (entry) =>
      entry.provider === provider &&
      (entry.status === "ready" || entry.status === "unverified"),
  );
  return account ? `atrium assign ${agent.ref} ${account.id}` : null;
}

export function requireAssignment(store: Store, id: string) {
  if (hasAssignment(store, id)) return;
  const accounts = store.all<AvailableAccount & { number: number }>(
    "SELECT number,provider,status FROM accounts ORDER BY number",
  );
  const command = assignmentCommand(
    store,
    id,
    accounts.map((entry) => ({
      ...entry,
      id: `k${entry.number}`,
    })),
  );
  throw new Problem(
    409,
    UNASSIGNED,
    "unassigned_account",
    undefined,
    command ?? "atrium account check",
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
