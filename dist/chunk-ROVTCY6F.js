import {
  alive
} from "./chunk-K4FNLP4I.js";
import "./chunk-DNL7I37E.js";
import "./chunk-JQF35LTD.js";

// server/tasks/secretary/secretary-lock.ts
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
function withLockDb(data, work) {
  const directory = join(data, "secretary");
  mkdirSync(directory, { recursive: true, mode: 448 });
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
function claimSecretary(data) {
  const token = randomUUID();
  const claimed = withLockDb(data, (db) => {
    const current = db.prepare("SELECT * FROM owner WHERE id=1").get();
    if (current && (alive(current.pid) || current.child_pid && alive(current.child_pid)))
      return false;
    db.prepare(
      "INSERT INTO owner(id,token,pid,child_pid) VALUES (1,?,?,NULL) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid,child_pid=NULL"
    ).run(token, process.pid);
    return true;
  });
  if (!claimed) return null;
  return {
    child(pid) {
      withLockDb(data, (db) => {
        db.prepare("UPDATE owner SET child_pid=? WHERE id=1 AND token=?").run(
          pid,
          token
        );
      });
    },
    release() {
      withLockDb(data, (db) => {
        db.prepare("DELETE FROM owner WHERE id=1 AND token=?").run(token);
      });
    }
  };
}
export {
  claimSecretary
};
