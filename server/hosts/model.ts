import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sameSecret } from "../../shared/secret.ts";
import type { SshConnection } from "./tunnel-plan.ts";
import { Problem } from "../problem.ts";
import { all, atomically, one } from "../tasks/ledger-model.ts";
import {
  connection,
  connectionText,
  hostRef,
  JOIN_TTL_MS,
  LOCAL_HOST,
  type Connection,
  type HostInfo,
  type HostLoadReport,
} from "./state.ts";

/**
 * 执行机器的账（#358 第 1 步）：hosts 一台一行（本机固定 h1，移除只打标记、短号不复用），
 * host_runs 记每个远程任务当前这一轮在哪台、第几轮、远程路径与日志收到哪儿。
 * 接入码与主机令牌只存哈希；原文只在登记时回给用户一次、接入时回给代理一次。
 */

export type HostRow = {
  id: number;
  name: string;
  kind: "local" | "remote";
  info: string | null;
  load: string | null;
  max_running: number | null;
  repos: string;
  paused: number;
  join_hash: string | null;
  join_expires_at: number | null;
  token_hash: string | null;
  joined_at: number | null;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
  removed_at: number | null;
  ssh_target: string | null;
  ssh_key: string | null;
  tunnel_local_port: number | null;
  tunnel_remote_port: number | null;
};

export type HostRun = {
  task_id: number;
  host_id: number;
  run: number;
  pid: number | null;
  clone: string | null;
  worktree: string | null;
  dir: string;
  log_offset: number;
  started_at: number;
};

export function ensureHostTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('local','remote')),
      info TEXT, load TEXT,
      max_running INTEGER,
      repos TEXT NOT NULL DEFAULT '[]',
      paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
      join_hash TEXT, join_expires_at INTEGER,
      token_hash TEXT,
      joined_at INTEGER, last_seen_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, removed_at INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS hosts_single_local ON hosts((1)) WHERE kind='local';
    CREATE TABLE IF NOT EXISTS host_runs (
      task_id INTEGER PRIMARY KEY,
      host_id INTEGER NOT NULL,
      run INTEGER NOT NULL,
      pid INTEGER,
      clone TEXT, worktree TEXT, dir TEXT NOT NULL,
      log_offset INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS host_runs_host ON host_runs(host_id,task_id);
    CREATE TABLE IF NOT EXISTS host_tunnel_invalid (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL,
      connection_json TEXT NOT NULL,
      archived_at INTEGER NOT NULL);`);
  const columns = new Set(
    (db.prepare("PRAGMA table_info(hosts)").all() as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  for (const [name, type] of Object.entries({
    ssh_target: "TEXT",
    ssh_key: "TEXT",
    tunnel_local_port: "INTEGER",
    tunnel_remote_port: "INTEGER",
  }))
    if (!columns.has(name))
      db.exec(`ALTER TABLE hosts ADD COLUMN ${name} ${type}`);
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** 本机登记为 h1（首次启动时表是空的，第一个自增号就是 1）；之后每次启动刷新机器信息。 */
export function ensureLocalHost(
  db: DatabaseSync,
  info: HostInfo,
  now = Date.now(),
) {
  const row = one<{ id: number }>(
    db,
    "SELECT id FROM hosts WHERE kind='local'",
  );
  if (row) {
    db.prepare("UPDATE hosts SET info=?,updated_at=? WHERE id=?").run(
      JSON.stringify(info),
      now,
      row.id,
    );
    return row.id;
  }
  const taken = one<{ id: number }>(
    db,
    "SELECT id FROM hosts WHERE id=?",
    LOCAL_HOST,
  );
  const result = db
    .prepare(
      `INSERT INTO hosts(${taken ? "" : "id,"}name,kind,info,repos,created_at,updated_at) VALUES (${taken ? "" : "?,"}?,'local',?,'["*"]',?,?)`,
    )
    .run(
      ...(taken ? [] : [LOCAL_HOST]),
      "本机",
      JSON.stringify(info),
      now,
      now,
    );
  return Number(result.lastInsertRowid);
}

export function localHostId(db: DatabaseSync) {
  return (
    one<{ id: number }>(db, "SELECT id FROM hosts WHERE kind='local'")?.id ??
    LOCAL_HOST
  );
}

export function hostRow(db: DatabaseSync, id: number): HostRow {
  const row = one<HostRow>(db, "SELECT * FROM hosts WHERE id=?", id);
  if (!row)
    throw new Problem(
      404,
      `没有主机 ${hostRef(id)}`,
      "not_found",
      undefined,
      "atrium host ls",
    );
  return row;
}

/** 列出主机（未移除的在前）；主机数量很小，仍按上限取。 */
export function hostRows(db: DatabaseSync, withRemoved = false) {
  return all<HostRow>(
    db,
    `SELECT * FROM hosts ${withRemoved ? "" : "WHERE removed_at IS NULL"} ORDER BY id LIMIT 500`,
  );
}

/** 启动隧道按短号分页读，不因主机列表视图的 500 条上限漏掉连接。 */
export function tunnelHostRows(db: DatabaseSync, after: number): HostRow[] {
  return all<HostRow>(
    db,
    `SELECT * FROM hosts WHERE removed_at IS NULL AND id>? AND
      (ssh_target IS NOT NULL OR ssh_key IS NOT NULL OR tunnel_local_port IS NOT NULL OR tunnel_remote_port IS NOT NULL)
      ORDER BY id LIMIT 100`,
    after,
  );
}

const NAME = /^[^\s\u0000-\u001f][^\u0000-\u001f]{0,39}$/;
const REPO = /^(\*|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/;

export function validRepos(repos: readonly string[]) {
  const cleaned = [
    ...new Set(repos.map((repo) => repo.trim()).filter(Boolean)),
  ];
  const bad = cleaned.find((repo) => !REPO.test(repo));
  if (bad)
    throw new Problem(
      400,
      `--repo 应为 owner/name 或 *（收到：${bad}）`,
      "usage",
    );
  if (cleaned.length > 50)
    throw new Problem(400, "--repo 最多登记 50 个", "usage");
  return cleaned;
}

export function validMax(value: unknown) {
  if (value === undefined || value === null) return null;
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 64
  )
    throw new Problem(400, "--max 应为 1 到 64 的整数", "usage");
  return value as number;
}

/** 登记一台远程主机并签发一次性接入码（`h<N>-<64 位十六进制>`，30 分钟内有效）。 */
export function addHost(
  db: DatabaseSync,
  input: {
    name: string;
    max?: number | null;
    repos?: readonly string[];
    ssh?: SshConnection | null;
  },
  now = Date.now(),
) {
  const name = input.name.trim();
  if (!NAME.test(name))
    throw new Problem(400, "名称：1 到 40 个字，不能以空白开头", "usage");
  const repos = validRepos(input.repos ?? []);
  const max = validMax(input.max);
  const secret = randomBytes(32).toString("hex");
  const id = atomically(db, () => {
    const result = db
      .prepare(
        "INSERT INTO hosts(name,kind,repos,max_running,join_hash,join_expires_at,created_at,updated_at,ssh_target,ssh_key,tunnel_local_port,tunnel_remote_port) VALUES (?,'remote',?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        name,
        JSON.stringify(repos),
        max,
        "",
        now + JOIN_TTL_MS,
        now,
        now,
        input.ssh?.target ?? null,
        input.ssh?.key ?? null,
        input.ssh?.localPort ?? null,
        input.ssh?.remotePort ?? null,
      );
    const id = Number(result.lastInsertRowid);
    db.prepare("UPDATE hosts SET join_hash=? WHERE id=?").run(
      digest(`${hostRef(id)}-${secret}`),
      id,
    );
    return id;
  });
  return { id, code: `${hostRef(id)}-${secret}` };
}

export function editHostConnection(
  db: DatabaseSync,
  id: number,
  ssh: SshConnection,
  now = Date.now(),
) {
  const row = hostRow(db, id);
  if (row.kind !== "remote" || row.removed_at !== null)
    throw new Problem(409, `${hostRef(id)} 不能编辑 SSH 连接`, "conflict");
  db.prepare(
    "UPDATE hosts SET ssh_target=?,ssh_key=?,tunnel_local_port=?,tunnel_remote_port=?,updated_at=? WHERE id=?",
  ).run(ssh.target, ssh.key, ssh.localPort, ssh.remotePort, now, id);
}

/** 损坏的单条 SSH 配置挪开留档，不阻碍其余主机或服务启动。 */
export function quarantineHostConnection(
  db: DatabaseSync,
  row: HostRow,
  now = Date.now(),
) {
  atomically(db, () => {
    db.prepare(
      "INSERT INTO host_tunnel_invalid(host_id,connection_json,archived_at) VALUES (?,?,?)",
    ).run(
      row.id,
      JSON.stringify({
        target: row.ssh_target,
        key: row.ssh_key,
        localPort: row.tunnel_local_port,
        remotePort: row.tunnel_remote_port,
      }),
      now,
    );
    db.prepare(
      "UPDATE hosts SET ssh_target=NULL,ssh_key=NULL,tunnel_local_port=NULL,tunnel_remote_port=NULL,updated_at=? WHERE id=?",
    ).run(now, row.id);
  });
}

const JOIN = /^h([1-9][0-9]{0,8})-([a-f0-9]{64})$/;
const JOIN_HEADER = /^Bearer (h[1-9][0-9]{0,8}-[a-f0-9]{64})$/;

/** 请求头里的接入码（`Bearer h<N>-…`）；格式不对为 null。 */
export const joinCodeOf = (authorization: string | undefined) =>
  JOIN_HEADER.exec(authorization ?? "")?.[1] ?? null;

/** 接入码现在有效（只读核对，认证入口用；真正作废在 joinHost 里）。 */
export function joinCodeValid(
  db: DatabaseSync,
  code: string,
  now = Date.now(),
) {
  const match = JOIN.exec(code);
  if (!match) return false;
  const row = one<HostRow>(
    db,
    "SELECT * FROM hosts WHERE id=?",
    Number(match[1]),
  );
  return (
    !!row &&
    row.kind === "remote" &&
    row.removed_at === null &&
    !!row.join_hash &&
    (row.join_expires_at ?? 0) >= now &&
    sameSecret(digest(code), row.join_hash)
  );
}
const TOKEN = /^Bearer h([1-9][0-9]{0,8})\.([a-f0-9]{64})$/;

export const looksLikeHostToken = (authorization: string | undefined) =>
  TOKEN.test(authorization ?? "");

/** 接入：接入码换成这台主机专用的令牌（只回这一次）；码用过即作废。 */
export function joinHost(
  db: DatabaseSync,
  code: string,
  info: HostInfo,
  now = Date.now(),
) {
  const match = JOIN.exec(code.trim());
  const refused = () =>
    new Problem(
      401,
      "接入码无效、已用过或已过期；在服务那台机器上重新运行 atrium host add 拿新的接入码",
      "auth_required",
    );
  if (!match) throw refused();
  const id = Number(match[1]);
  const row = one<HostRow>(db, "SELECT * FROM hosts WHERE id=?", id);
  if (
    !row ||
    row.kind !== "remote" ||
    row.removed_at !== null ||
    !row.join_hash ||
    (row.join_expires_at ?? 0) < now ||
    !sameSecret(digest(code.trim()), row.join_hash)
  )
    throw refused();
  const secret = randomBytes(32).toString("hex");
  const token = `${hostRef(id)}.${secret}`;
  db.prepare(
    "UPDATE hosts SET token_hash=?,join_hash=NULL,join_expires_at=NULL,joined_at=?,last_seen_at=?,info=?,updated_at=? WHERE id=?",
  ).run(digest(token), now, now, JSON.stringify(info), now, id);
  return { id, token };
}

/** 主机令牌有效时返回主机号，否则 null。 */
export function verifyHostToken(
  db: DatabaseSync,
  authorization: string | undefined,
): number | null {
  const match = TOKEN.exec(authorization ?? "");
  if (!match) return null;
  const id = Number(match[1]);
  const row = one<Pick<HostRow, "token_hash" | "removed_at">>(
    db,
    "SELECT token_hash,removed_at FROM hosts WHERE id=?",
    id,
  );
  if (!row?.token_hash || row.removed_at !== null) return null;
  return sameSecret(
    digest(`${hostRef(id)}.${match[2]!.toLowerCase()}`),
    row.token_hash,
  )
    ? id
    : null;
}

export function updateInfo(
  db: DatabaseSync,
  id: number,
  info: HostInfo,
  now = Date.now(),
) {
  db.prepare(
    "UPDATE hosts SET info=?,last_seen_at=?,updated_at=? WHERE id=?",
  ).run(JSON.stringify(info), now, now, id);
}

export function touchHost(
  db: DatabaseSync,
  id: number,
  load: HostLoadReport | null,
  now = Date.now(),
) {
  if (load)
    db.prepare("UPDATE hosts SET load=?,last_seen_at=? WHERE id=?").run(
      JSON.stringify(load),
      now,
      id,
    );
  else db.prepare("UPDATE hosts SET last_seen_at=? WHERE id=?").run(now, id);
}

export function setPaused(db: DatabaseSync, id: number, paused: boolean) {
  const row = hostRow(db, id);
  if (row.removed_at !== null)
    throw new Problem(409, `${hostRef(id)} 已移除`, "conflict");
  db.prepare("UPDATE hosts SET paused=?,updated_at=? WHERE id=?").run(
    paused ? 1 : 0,
    Date.now(),
    id,
  );
}

/** 移除远程主机：令牌作废、短号保留不复用；上面还有在跑的任务时拒绝。 */
export function removeHost(db: DatabaseSync, id: number, now = Date.now()) {
  const row = hostRow(db, id);
  if (row.kind === "local")
    throw new Problem(
      409,
      "本机（h1）不能移除；不想在本机跑可以 atrium host pause h1",
      "conflict",
    );
  if (row.removed_at !== null)
    throw new Problem(409, `${hostRef(id)} 已移除`, "conflict");
  const running = one<{ id: number }>(
    db,
    "SELECT id FROM tasks WHERE status='running' AND host_id=? LIMIT 1",
    id,
  );
  if (running)
    throw new Problem(
      409,
      `${hostRef(id)} 上还有在跑的任务 t${running.id}；先停下或等它结束`,
      "conflict",
      undefined,
      `atrium task stop t${running.id}`,
    );
  db.prepare(
    "UPDATE hosts SET removed_at=?,token_hash=NULL,join_hash=NULL,join_expires_at=NULL,updated_at=? WHERE id=?",
  ).run(now, now, id);
}

// ---- 远程运行 ----

export function hostRun(db: DatabaseSync, task: number) {
  return one<HostRun>(db, "SELECT * FROM host_runs WHERE task_id=?", task);
}

/** 这个任务在远程的下一轮号（从 1 起，换主机也接着数）。 */
export function nextRun(db: DatabaseSync, task: number) {
  return (hostRun(db, task)?.run ?? 0) + 1;
}

export function beginRun(
  db: DatabaseSync,
  run: Omit<HostRun, "log_offset"> & { log_offset: number },
) {
  db.prepare(
    `INSERT INTO host_runs(task_id,host_id,run,pid,clone,worktree,dir,log_offset,started_at) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(task_id) DO UPDATE SET host_id=excluded.host_id,run=excluded.run,pid=excluded.pid,clone=excluded.clone,
       worktree=excluded.worktree,dir=excluded.dir,log_offset=excluded.log_offset,started_at=excluded.started_at`,
  ).run(
    run.task_id,
    run.host_id,
    run.run,
    run.pid,
    run.clone,
    run.worktree,
    run.dir,
    run.log_offset,
    run.started_at,
  );
}

export function setLogOffset(db: DatabaseSync, task: number, offset: number) {
  db.prepare("UPDATE host_runs SET log_offset=? WHERE task_id=?").run(
    offset,
    task,
  );
}

export function endRun(db: DatabaseSync, task: number) {
  db.prepare("DELETE FROM host_runs WHERE task_id=?").run(task);
}

/** 账本里在这台主机上跑着的任务与轮号（重连对账用）。 */
export function runningOn(db: DatabaseSync, host: number) {
  return all<{ task: number; run: number }>(
    db,
    `SELECT r.task_id AS task, r.run AS run FROM host_runs r JOIN tasks t ON t.id=r.task_id
     WHERE r.host_id=? AND t.status='running' AND t.host_id=? ORDER BY r.task_id LIMIT 1000`,
    host,
    host,
  );
}

// ---- 视图 ----

export type HostView = {
  ref: string;
  name: string;
  kind: "local" | "remote";
  connection: Connection;
  status: string;
  paused: boolean;
  removed: boolean;
  info: HostInfo | null;
  load: HostLoadReport | null;
  repos: string[];
  /** 同时最多跑几个：登记时指定的优先，否则代理（或本机）按核数算的。 */
  max: number | null;
  running: number;
  joined_at: number | null;
  last_seen_at: number | null;
  ssh:
    | (SshConnection & {
        tunnel: string;
        status: string;
        error: string | null;
        agentServer: string;
      })
    | null;
};

const parse = <T>(text: string | null): T | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

export function hostView(
  row: HostRow,
  runtime: {
    polling: boolean;
    running: number;
    localMax?: number | null;
    /** 多久没来算离线；缺省 ONLINE_MS。 */
    onlineMs?: number;
    tunnel?: { status: string; error: string | null } | null;
  },
  now = Date.now(),
): HostView {
  const info = parse<HostInfo>(row.info);
  const state = connection({
    kind: row.kind,
    joined: row.token_hash !== null,
    joinExpiresAt: row.join_expires_at,
    lastSeenAt: row.last_seen_at,
    polling: runtime.polling,
    now,
    onlineMs: runtime.onlineMs,
  });
  return {
    ref: hostRef(row.id),
    name: row.name,
    kind: row.kind,
    connection: state,
    status:
      row.removed_at !== null
        ? "已移除"
        : connectionText(state, {
            paused: row.paused === 1,
            lastSeenAt: row.last_seen_at,
            joinExpiresAt: row.join_expires_at,
            now,
          }),
    paused: row.paused === 1,
    removed: row.removed_at !== null,
    info,
    load: parse<HostLoadReport>(row.load),
    repos: parse<string[]>(row.repos) ?? [],
    max:
      row.max_running ??
      (row.kind === "local"
        ? (runtime.localMax ?? null)
        : (info?.max_workers ?? null)),
    running: runtime.running,
    joined_at: row.joined_at,
    last_seen_at: row.last_seen_at,
    ssh:
      row.ssh_target &&
      row.tunnel_local_port !== null &&
      row.tunnel_remote_port !== null
        ? {
            target: row.ssh_target,
            key: row.ssh_key,
            localPort: row.tunnel_local_port,
            remotePort: row.tunnel_remote_port,
            tunnel: `${row.tunnel_local_port}:${row.tunnel_remote_port}`,
            status: runtime.tunnel?.status ?? "未启动",
            error: runtime.tunnel?.error ?? null,
            agentServer: `http://127.0.0.1:${row.tunnel_remote_port}`,
          }
        : null,
  };
}
