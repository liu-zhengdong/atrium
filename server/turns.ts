import type { RuntimeEventPage } from "../shared/trace.ts";
import type { Store } from "./store.ts";

export type ActiveTurn = {
  runtime_id: string;
  generation: string;
  failure: string | null;
  delivery_at: number | null;
  started_seq: number;
};

type Event = RuntimeEventPage["items"][number];

/** The trace cursor and the open turn are one checkpoint, not two independent clocks. */
export class TurnLedger {
  constructor(private store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_turns (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      runtime_id TEXT NOT NULL, generation TEXT NOT NULL, started_seq INTEGER NOT NULL,
      failure TEXT, delivery_at INTEGER);
      CREATE TABLE IF NOT EXISTS migration_marks (name TEXT PRIMARY KEY);`);
    this.migrate();
  }

  current(id: string): ActiveTurn | null {
    return (
      this.store.one<ActiveTurn>(
        "SELECT runtime_id,generation,started_seq,failure,delivery_at FROM runtime_turns WHERE agent_id=?",
        id,
      ) ?? null
    );
  }

  clear(id: string) {
    this.store.run("DELETE FROM runtime_turns WHERE agent_id=?", id);
  }

  /** Called inside TraceStore.ingest's transaction, before its cursor advances. */
  ingest(id: string, runtime: string, generation: string, event: Event) {
    if (event.kind === "run_start") {
      const previous = this.current(id);
      const deliveryAt =
        previous?.runtime_id === runtime && previous.generation === generation
          ? previous.delivery_at
          : (this.store.one<{ at: number }>(
              `SELECT MIN(at) AS at FROM trace_actions WHERE agent_id=? AND runtime_id=?
             AND generation=? AND kind='delivery' AND name='Atrium' AND seq>COALESCE(
               (SELECT MAX(seq) FROM trace_actions WHERE agent_id=? AND runtime_id=?
                AND generation=? AND kind='run_end' AND seq<?),0) AND seq<=?`,
              id,
              runtime,
              generation,
              id,
              runtime,
              generation,
              event.seq,
              event.seq,
            )?.at ?? null);
      this.store.run(
        `INSERT INTO runtime_turns(agent_id,runtime_id,generation,started_seq,failure,delivery_at)
         VALUES(?,?,?,?,NULL,?) ON CONFLICT(agent_id) DO UPDATE SET
         runtime_id=excluded.runtime_id,generation=excluded.generation,
         started_seq=CASE WHEN runtime_id=excluded.runtime_id AND generation=excluded.generation
           THEN started_seq ELSE excluded.started_seq END,
         failure=NULL,delivery_at=excluded.delivery_at`,
        id,
        runtime,
        generation,
        event.seq,
        deliveryAt,
      );
      return null;
    }
    const turn = this.current(id);
    if (!turn || turn.runtime_id !== runtime || turn.generation !== generation)
      return null;
    if (event.kind === "delivery" && event.name === "Atrium") {
      this.store.run(
        "UPDATE runtime_turns SET delivery_at=COALESCE(delivery_at,?) WHERE agent_id=?",
        event.at,
        id,
      );
    } else if (
      event.kind === "message" &&
      event.name === "assistant" &&
      event.error
    ) {
      this.store.run(
        "UPDATE runtime_turns SET failure=? WHERE agent_id=?",
        event.text || "模型运行失败",
        id,
      );
    } else if (event.kind === "run_end") {
      this.clear(id);
      // A run without an Atrium delivery proves nothing about old accepted work.
      if (turn.delivery_at !== null)
        this.store.finishTurn(id, !turn.failure, turn.delivery_at);
      return turn;
    }
    return null;
  }

  /** A one-time upgrade of the previous, in-memory-only turn checkpoint. */
  private migrate() {
    if (
      this.store.one(
        "SELECT 1 FROM migration_marks WHERE name='accepted-turn-checkpoint-v1'",
      )
    )
      return;
    this.store.transaction(() => {
      // Old deliveries belong to a previous Pi session. Pi confirmed receipt;
      // do not inject yesterday's work into the new session a second time.
      const obsolete = this.store.all<{ agent_id: string; n: number }>(
        `SELECT d.agent_id,COUNT(*) AS n FROM deliveries d JOIN agents a ON a.id=d.agent_id
         WHERE d.state='accepted' AND a.deleted_at IS NULL AND d.accepted_at IS NOT NULL
         AND d.accepted_at < COALESCE(a.session_reset_at,
           (SELECT MIN(t.at) FROM trace_actions t WHERE t.agent_id=a.id
            AND t.runtime_id=a.runtime_id AND t.session_id=a.acp_session_id
            AND t.kind='session' AND t.seq=1)) GROUP BY d.agent_id`,
      );
      this.store.run(
        `UPDATE deliveries SET state='complete' WHERE state='accepted' AND accepted_at IS NOT NULL
         AND agent_id IN (SELECT id FROM agents WHERE deleted_at IS NULL)
         AND accepted_at < COALESCE((SELECT session_reset_at FROM agents WHERE id=deliveries.agent_id),
           (SELECT MIN(t.at) FROM trace_actions t JOIN agents a ON a.id=t.agent_id
            WHERE t.agent_id=deliveries.agent_id AND t.runtime_id=a.runtime_id
            AND t.session_id=a.acp_session_id AND t.kind='session' AND t.seq=1))`,
      );
      for (const row of obsolete)
        console.info(
          `[Atrium] 旧会话已接收的投递直接完成：${row.agent_id} ${row.n} 条`,
        );

      const deleted = this.store.all<{ agent_id: string; n: number }>(
        `SELECT d.agent_id,COUNT(*) AS n FROM deliveries d JOIN agents a ON a.id=d.agent_id
         WHERE a.deleted_at IS NOT NULL AND d.state IN ('pending','accepted') GROUP BY d.agent_id`,
      );
      this.store.run(
        `DELETE FROM deliveries WHERE state IN ('pending','accepted')
         AND agent_id IN (SELECT id FROM agents WHERE deleted_at IS NOT NULL)`,
      );
      for (const row of deleted)
        console.info(
          `[Atrium] 已删除身份遗留投递清理：${row.agent_id} ${row.n} 条`,
        );

      // A running Pi can outlive this server. Recover the open group of its
      // current generation from the tail, if both start and end are observable.
      const active = this.store.all<{
        agent_id: string;
        runtime_id: string;
        generation: string;
      }>(
        `SELECT a.id AS agent_id,t.runtime_id,t.generation FROM agents a
         JOIN trace_actions t ON t.id=(SELECT MAX(x.id) FROM trace_actions x
           WHERE x.agent_id=a.id AND x.runtime_id=a.runtime_id AND x.session_id=a.acp_session_id)
         WHERE a.deleted_at IS NULL AND a.runtime_id IS NOT NULL`,
      );
      for (const row of active) {
        const lastEnd =
          this.store.one<{ seq: number }>(
            `SELECT MAX(seq) AS seq FROM trace_actions WHERE agent_id=? AND runtime_id=?
             AND generation=? AND kind='run_end'`,
            row.agent_id,
            row.runtime_id,
            row.generation,
          )?.seq ?? 0;
        const start = this.store.one<{ seq: number }>(
          `SELECT MIN(seq) AS seq FROM trace_actions WHERE agent_id=? AND runtime_id=?
           AND generation=? AND kind='run_start' AND seq>?`,
          row.agent_id,
          row.runtime_id,
          row.generation,
          lastEnd,
        )?.seq;
        if (start == null) continue;
        const failure =
          this.store.one<{ output: string }>(
            `SELECT output FROM trace_actions WHERE agent_id=? AND runtime_id=? AND generation=?
           AND kind='message' AND name='assistant' AND state='error' AND seq>=?
           ORDER BY seq DESC LIMIT 1`,
            row.agent_id,
            row.runtime_id,
            row.generation,
            start,
          )?.output ?? null;
        const deliveryAt =
          this.store.one<{ at: number }>(
            `SELECT MIN(at) AS at FROM trace_actions WHERE agent_id=? AND runtime_id=?
           AND generation=? AND kind='delivery' AND name='Atrium' AND seq>?`,
            row.agent_id,
            row.runtime_id,
            row.generation,
            lastEnd,
          )?.at ?? null;
        this.store.run(
          `INSERT OR REPLACE INTO runtime_turns(agent_id,runtime_id,generation,started_seq,failure,delivery_at)
           VALUES(?,?,?,?,?,?)`,
          row.agent_id,
          row.runtime_id,
          row.generation,
          start,
          failure,
          deliveryAt,
        );
      }
      this.store.run(
        "INSERT INTO migration_marks(name) VALUES('accepted-turn-checkpoint-v1')",
      );
    });
  }
}
