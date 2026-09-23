import { Problem, type Store } from "./store.ts";
import type { Assignment, Mode, Row } from "./account-files.ts";

export class AccountCatalog {
  constructor(private store: Store) {}
  row(number: number) {
    const row = this.store.one<Row>(
      "SELECT * FROM accounts WHERE number=?",
      number,
    );
    if (!row) throw new Problem(404, "账号不存在");
    return row;
  }
  number(ref: string) {
    if (!/^k[1-9]\d{0,14}$/.test(ref)) throw new Problem(404, "账号不存在");
    return this.row(Number(ref.slice(1))).number;
  }
  assigned(number: number) {
    return this.store.all<Assignment>(
      `SELECT x.*,a.agent_directory FROM account_assignments x
      JOIN agents a ON a.id=x.agent_id WHERE x.account_number=? AND a.deleted_at IS NULL`,
      number,
    );
  }
  mode(id: string): Mode {
    return (
      this.store.one<{ mode: Mode }>(
        "SELECT mode FROM credential_modes WHERE agent_id=?",
        id,
      )?.mode ?? "shared"
    );
  }
  credentialMode(id: string) {
    return this.mode(this.store.agent(id).id);
  }
  list() {
    return this.store
      .all<Row>("SELECT * FROM accounts ORDER BY number")
      .map((r) => ({
        id: `k${r.number}`,
        provider: r.provider,
        name: r.name,
        type: r.type,
        expires: r.expires,
        status: r.status,
        last_error: r.last_error,
        assigned: this.assigned(r.number).map(
          (a) => this.store.agent(a.agent_id).ref,
        ),
      }));
  }
  rename(ref: string, name: string) {
    this.store.run(
      "UPDATE accounts SET name=? WHERE number=?",
      name,
      this.number(ref),
    );
    return { renamed: true };
  }
}
