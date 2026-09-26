import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Problem, type Store } from "./store.ts";
import { readIdentityModel } from "./profile.ts";
import {
  checkLocalLogin,
  LOCAL_COMMAND,
  LOCAL_NAME,
  LOCAL_PROVIDER,
} from "./local-account.ts";

export const UNASSIGNED = "未分配账号";

/** An assignment is the only authority to launch a managed identity. */
export function hasAssignment(store: Store, id: string): boolean {
  return !!store.one(
    `SELECT 1 FROM account_assignments x JOIN accounts a ON a.number=x.account_number
     WHERE x.agent_id=? LIMIT 1`,
    id,
  );
}

type AvailableAccount = { id: string; provider: string; status: string };

/** Recommend only a usable account for the identity's configured model provider. */
export function assignmentCommand(
  store: Store,
  id: string,
  accounts: AvailableAccount[],
  previouslyAssigned?: string,
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
  const candidates = accounts.filter(
    (entry) =>
      (provider
        ? entry.provider === provider
        : entry.id === previouslyAssigned) &&
      (entry.status === "ready" ||
        entry.status === "unverified" ||
        entry.provider === LOCAL_PROVIDER),
  );
  const account =
    candidates.find((entry) => entry.id === previouslyAssigned) ??
    candidates[0];
  // 不再新建 Claude 账号（#242），没有可分配的 Claude 账号时不给修正命令。
  return account ? `atrium assign ${agent.ref} ${account.id}` : null;
}

export function requireAssignment(store: Store, id: string) {
  const local = store.one<{ number: number }>(
    `SELECT a.number FROM account_assignments x JOIN accounts a ON a.number=x.account_number
     WHERE x.agent_id=? AND a.type='local'`,
    id,
  );
  if (local) {
    const globalReason = checkLocalLogin(store);
    store.run(
      "UPDATE accounts SET status=?,last_error=? WHERE number=?",
      globalReason ? "error" : "ready",
      globalReason,
      local.number,
    );
    const reason = checkLocalLogin(store, id);
    if (reason)
      throw new Problem(
        409,
        reason,
        "local_login_unavailable",
        undefined,
        LOCAL_COMMAND,
      );
  }
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
  // One-time transition: the old shared Claude bridge had no token to import.
  // Persist a marker even if there are no matching identities so later manual
  // unassignments are never undone by another service restart.
  store.transaction(() => {
    store.run(
      "CREATE TABLE IF NOT EXISTS migration_marks (name TEXT PRIMARY KEY)",
    );
    if (
      !store.one(
        "SELECT 1 FROM migration_marks WHERE name='local-claude-bridge'",
      )
    ) {
      const candidates = store.agents().filter((agent) => {
        if (!agent.agent_directory || hasAssignment(store, agent.id))
          return false;
        if (
          store.one<{ mode: string }>(
            "SELECT mode FROM credential_modes WHERE agent_id=?",
            agent.id,
          )?.mode === "assigned"
        )
          return false;
        try {
          return (
            readIdentityModel(agent.agent_directory)?.provider ===
            LOCAL_PROVIDER
          );
        } catch {
          return false;
        } // A damaged model config remains unassigned, never guessed.
      });
      if (candidates.length) {
        const reason = checkLocalLogin(store);
        const existing = store.one<{ number: number }>(
          "SELECT number FROM accounts WHERE provider=? AND type='local'",
          LOCAL_PROVIDER,
        );
        const number =
          existing?.number ??
          Number(
            store.run(
              "INSERT INTO accounts(provider,name,type,status,last_error) VALUES(?,?,'local',?,?)",
              LOCAL_PROVIDER,
              LOCAL_NAME,
              reason ? "error" : "ready",
              reason,
            ).lastInsertRowid,
          );
        for (const agent of candidates) {
          store.run(
            "INSERT INTO account_assignments(agent_id,provider,account_number) VALUES(?,?,?)",
            agent.id,
            LOCAL_PROVIDER,
            number,
          );
          store.run(
            "INSERT INTO credential_modes(agent_id,mode) VALUES(?,'assigned') ON CONFLICT(agent_id) DO UPDATE SET mode='assigned'",
            agent.id,
          );
        }
      }
      store.run(
        "INSERT INTO migration_marks(name) VALUES('local-claude-bridge')",
      );
    }
  });
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
