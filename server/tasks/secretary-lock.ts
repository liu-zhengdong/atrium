import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { alive } from "../service-state.ts";

type Owner = { token: string; pid: number; child_pid: number | null };

/** A separate single-row database coordinates the UI and service processes atomically. */
function withLockDb<T>(data: string, work: (db: DatabaseSync) => T): T {
  const directory = join(data, "secretary");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, "owner.sqlite"));
  try {
    db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS owner (
        id INTEGER PRIMARY KEY CHECK(id=1),
        token TEXT NOT NULL,
        pid INTEGER NOT NULL,
        child_pid INTEGER
      );
      BEGIN IMMEDIATE;`);
    try {
      const result = work(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

/** The UI holds ownership for its lifetime; fallback holds it for one turn. */
export function claimSecretary(data: string): {
  child(pid: number): void;
  release(): void;
} | null {
  const token = randomUUID();
  const claimed = withLockDb(data, (db) => {
    const current = db.prepare("SELECT * FROM owner WHERE id=1").get() as
      Owner | undefined;
    if (
      current &&
      (alive(current.pid) || (current.child_pid && alive(current.child_pid)))
    )
      return false;
    db.prepare(
      "INSERT INTO owner(id,token,pid,child_pid) VALUES (1,?,?,NULL) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid,child_pid=NULL",
    ).run(token, process.pid);
    return true;
  });
  if (!claimed) return null;
  return {
    child(pid) {
      withLockDb(data, (db) => {
        db.prepare("UPDATE owner SET child_pid=? WHERE id=1 AND token=?").run(
          pid,
          token,
        );
      });
    },
    release() {
      withLockDb(data, (db) => {
        db.prepare("DELETE FROM owner WHERE id=1 AND token=?").run(token);
      });
    },
  };
}
