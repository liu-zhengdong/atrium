import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { atomically } from "./ledger.ts";

/** 全局合入队首的进程占用。旧进程仍在时，新服务不能碰同一工作树。 */
export class MergeClaim {
  readonly token = randomUUID();

  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS merge_claim (
      id INTEGER PRIMARY KEY CHECK(id=1), task_id INTEGER NOT NULL,
      pid INTEGER NOT NULL, token TEXT NOT NULL)`);
  }

  acquire(taskId: number): boolean {
    return atomically(this.db, () => {
      const held = this.db
        .prepare("SELECT pid,token FROM merge_claim WHERE id=1")
        .get() as { pid: number; token: string } | undefined;
      if (held) {
        if (held.token === this.token) return false;
        try {
          process.kill(held.pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
          this.db.prepare("DELETE FROM merge_claim WHERE id=1").run();
        }
      }
      this.db
        .prepare(
          "INSERT INTO merge_claim(id,task_id,pid,token) VALUES (1,?,?,?)",
        )
        .run(taskId, process.pid, this.token);
      return true;
    });
  }

  release() {
    this.db
      .prepare("DELETE FROM merge_claim WHERE id=1 AND token=?")
      .run(this.token);
  }
}
