import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  all,
  nodeByAddress,
  nodes,
  one,
  ref as nodeRef,
  transaction,
  type NodeRow,
} from "../org/model.ts";
import {
  PAGE_DEFAULT,
  PAGE_MAX,
  resolveSecrets,
  secretName,
  staleSecret,
  type SecretCandidate,
} from "./model.ts";
import { hasTable, marks } from "../sqlite.ts";

/**
 * 凭据的存储：`node_secrets` 一个凭据一行（只有名称、时间、谁设的、清理线索，没有值），
 * `task_secrets` 记任务声明要用哪些；值放数据目录 `secrets/<id>`（目录 0700、文件 0600，先写临时文件再改名）。
 * 旧运行时的 runner_credentials、credential_modes 表不读不写。判定在 model.ts。
 */

export function ensureSecretTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS node_secrets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER, last_used_task INTEGER,
    archived_at INTEGER, archived_by TEXT, archive_note TEXT,
    keep_at INTEGER, keep_by TEXT, keep_note TEXT,
    hinted_at INTEGER,
    UNIQUE(node_id,name));
  CREATE INDEX IF NOT EXISTS node_secrets_name ON node_secrets(name,archived_at);
  CREATE TABLE IF NOT EXISTS task_secrets (
    task_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    pos INTEGER NOT NULL,
    PRIMARY KEY(task_id,name));`);
}

export type SecretRow = {
  id: number;
  node_id: number;
  name: string;
  created_by: string;
  created_at: number;
  updated_by: string;
  updated_at: number;
  last_used_at: number | null;
  last_used_task: number | null;
  archived_at: number | null;
  archived_by: string | null;
  archive_note: string | null;
  keep_at: number | null;
  keep_by: string | null;
  keep_note: string | null;
  hinted_at: number | null;
};

const secretsRoot = (data: string) => join(data, "secrets");
const valueFile = (data: string, id: number) =>
  join(secretsRoot(data), String(id));

/** 给人看的一行：没有值，也不给值的长度。 */
function secretView(
  row: SecretRow,
  list?: ReadonlyMap<number, NodeRow>,
  now = Date.now(),
) {
  return {
    node: nodeRef(row.node_id),
    node_name: list?.get(row.node_id)?.name ?? null,
    name: row.name,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
    last_used_at: row.last_used_at,
    last_used_task:
      row.last_used_task === null ? null : `t${row.last_used_task}`,
    archived: row.archived_at !== null,
    archived_at: row.archived_at,
    archive_note: row.archive_note,
    keep_at: row.keep_at,
    keep_note: row.keep_note,
    stale: staleSecret(row, now)?.reason ?? null,
  };
}
export type SecretView = ReturnType<typeof secretView>;

const byId = (db: DatabaseSync) => new Map(nodes(db).map((n) => [n.id, n]));

function findRow(db: DatabaseSync, node: number, name: string) {
  return one<SecretRow>(
    db,
    "SELECT * FROM node_secrets WHERE node_id=? AND name=?",
    node,
    name,
  );
}

function getSecret(db: DatabaseSync, address: unknown, name: unknown) {
  if (typeof address !== "string" || !address.trim())
    throw new Problem(400, "节点: 要写凭据挂在哪个节点上，如 o4", "usage");
  const node = nodeByAddress(db, address.trim());
  const key = secretName(name);
  const row = findRow(db, node.id, key);
  if (!row)
    throw new Problem(
      404,
      `${nodeRef(node.id)} 上没有凭据 ${key}`,
      "not_found",
      undefined,
      `atrium secret ls --node ${nodeRef(node.id)}`,
    );
  return row;
}

/** 值落盘：先写同目录的临时文件（0600）再改名，半截的值不会被读到。 */
function writeValue(data: string, id: number, value: string) {
  const root = secretsRoot(data);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
  } catch {
    // Windows 上没有这套权限位，按用户目录的访问控制。
  }
  const temp = join(root, `.${id}-${randomBytes(6).toString("hex")}`);
  writeFileSync(temp, value, { mode: 0o600 });
  renameSync(temp, valueFile(data, id));
}

/**
 * 设值（新建或覆盖）：同一节点同名的覆盖；已归档的顺带恢复（要用就说明还有用）。
 * 回执不带值；事务里写库与落盘，落盘失败库也不改。
 */
export function setSecret(
  db: DatabaseSync,
  data: string,
  input: { node: string; name: string; value: string },
  by: string,
  now = Date.now(),
) {
  const node = nodeByAddress(db, input.node);
  const name = secretName(input.name);
  return transaction(db, () => {
    const had = findRow(db, node.id, name);
    let id: number;
    if (had) {
      id = had.id;
      db.prepare(
        "UPDATE node_secrets SET updated_by=?,updated_at=?,archived_at=NULL,archived_by=NULL,archive_note=NULL,hinted_at=NULL WHERE id=?",
      ).run(by, now, id);
    } else {
      id = Number(
        db
          .prepare(
            "INSERT INTO node_secrets(node_id,name,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?)",
          )
          .run(node.id, name, by, now, by, now).lastInsertRowid,
      );
    }
    writeValue(data, id, input.value);
    const row = one<SecretRow>(
      db,
      "SELECT * FROM node_secrets WHERE id=?",
      id,
    )!;
    return {
      ...secretView(row, byId(db), now),
      created: !had,
      restored: had?.archived_at != null,
    };
  });
}

export function listSecrets(
  db: DatabaseSync,
  query: {
    node?: string;
    archived?: boolean;
    before?: string;
    limit?: string;
  },
  now = Date.now(),
) {
  const where: string[] = [
    query.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL",
  ];
  const args: SQLInputValue[] = [];
  if (query.node) {
    where.push("node_id=?");
    args.push(nodeByAddress(db, query.node).id);
  }
  if (query.before !== undefined && query.before !== "") {
    const before = Number(query.before);
    if (!Number.isSafeInteger(before) || before < 1)
      throw new Problem(400, "--before: 应为上一页回执给的数字", "usage");
    where.push("id<?");
    args.push(before);
  }
  let limit = PAGE_DEFAULT;
  if (query.limit !== undefined && query.limit !== "") {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX)
      throw new Problem(400, `--limit: 应为 1～${PAGE_MAX} 的整数`, "usage");
  }
  const rows = all<SecretRow>(
    db,
    `SELECT * FROM node_secrets WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`,
    ...args,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const list = byId(db);
  return {
    secrets: page.map((r) => secretView(r, list, now)),
    next_before: rows.length > limit ? page.at(-1)!.id : null,
  };
}

export function setSecretState(
  db: DatabaseSync,
  input: { node?: unknown; name?: unknown },
  action: "archive" | "restore" | "keep",
  note: string | null,
  by: string,
  now = Date.now(),
) {
  const row = getSecret(db, input.node, input.name);
  const label = `${nodeRef(row.node_id)} 的 ${row.name}`;
  if (action === "archive") {
    if (row.archived_at !== null)
      throw new Problem(409, `${label} 已经归档了`, "conflict");
    db.prepare(
      "UPDATE node_secrets SET archived_at=?,archived_by=?,archive_note=? WHERE id=?",
    ).run(now, by, note, row.id);
  } else if (action === "restore") {
    if (row.archived_at === null)
      throw new Problem(409, `${label} 没有归档`, "conflict");
    db.prepare(
      "UPDATE node_secrets SET archived_at=NULL,archived_by=NULL,archive_note=?,hinted_at=NULL WHERE id=?",
    ).run(note, row.id);
  } else {
    if (note === null)
      throw new Problem(
        400,
        "--note: 留下要写一句原因（之后清理线索不再提它）",
        "usage",
      );
    db.prepare(
      "UPDATE node_secrets SET keep_at=?,keep_by=?,keep_note=? WHERE id=?",
    ).run(now, by, note, row.id);
  }
  return secretView(
    one<SecretRow>(db, "SELECT * FROM node_secrets WHERE id=?", row.id)!,
    byId(db),
    now,
  );
}

/** 真删（只有用户）：库里的行与值文件一起删。 */
export function removeSecret(
  db: DatabaseSync,
  data: string,
  input: { node?: unknown; name?: unknown },
) {
  const row = getSecret(db, input.node, input.name);
  const view = secretView(row, byId(db));
  db.prepare("DELETE FROM node_secrets WHERE id=?").run(row.id);
  rmSync(valueFile(data, row.id), { force: true });
  return view;
}

/** 某些节点上疑似没用的凭据（清理线索）；一次查出、判定在 model.ts。 */
export function staleSecrets(
  db: DatabaseSync,
  nodeIds: readonly number[],
  now = Date.now(),
) {
  if (!nodeIds.length || !hasTable(db, "node_secrets")) return [];
  const list = byId(db);
  return all<SecretRow>(
    db,
    `SELECT * FROM node_secrets WHERE archived_at IS NULL AND keep_at IS NULL AND node_id IN (${marks(nodeIds)}) ORDER BY id LIMIT 2000`,
    ...nodeIds,
  )
    .map((row) => ({ row, view: secretView(row, list, now) }))
    .filter((item) => item.view.stale !== null);
}

export function markSecretsHinted(
  db: DatabaseSync,
  ids: readonly number[],
  now: number,
) {
  if (!ids.length) return;
  db.prepare(
    `UPDATE node_secrets SET hinted_at=? WHERE id IN (${marks(ids)})`,
  ).run(now, ...ids);
}

// ---- 任务声明要用的凭据 ----

export function taskSecretNames(db: DatabaseSync, taskId: number): string[] {
  if (!hasTable(db, "task_secrets")) return [];
  return all<{ name: string }>(
    db,
    "SELECT name FROM task_secrets WHERE task_id=? ORDER BY pos LIMIT 50",
    taskId,
  ).map((r) => r.name);
}

/** 在调用方的事务里整体覆盖。 */
export function writeTaskSecrets(
  db: DatabaseSync,
  taskId: number,
  names: readonly string[],
) {
  db.prepare("DELETE FROM task_secrets WHERE task_id=?").run(taskId);
  const insert = db.prepare(
    "INSERT INTO task_secrets(task_id,name,pos) VALUES(?,?,?)",
  );
  names.forEach((name, pos) => insert.run(taskId, name, pos));
}

/** 本节点在前、逐级往上的节点链；没有节点时是各个根节点；没有组织树时为空。 */
function secretChain(db: DatabaseSync, start: number | null) {
  if (!hasTable(db, "org_nodes")) return [];
  const list = nodes(db);
  if (start === null)
    return list.filter((n) => n.parent_id === null).map((n) => n.id);
  const parents = new Map(list.map((n) => [n.id, n.parent_id]));
  const chain: number[] = [];
  for (
    let id: number | null | undefined = start;
    id != null && !chain.includes(id);
    id = parents.get(id)
  )
    chain.push(id);
  return chain;
}

/** 在节点链上按名称找（只看没归档的，一次查询）。 */
function findSecrets(
  db: DatabaseSync,
  start: number | null,
  names: readonly string[],
) {
  const chain = secretChain(db, start);
  const candidates =
    names.length && chain.length && hasTable(db, "node_secrets")
      ? all<SecretCandidate>(
          db,
          `SELECT id,node_id,name FROM node_secrets WHERE archived_at IS NULL AND name IN (${marks(names)}) AND node_id IN (${marks(chain)})`,
          ...names,
          ...chain,
        )
      : [];
  return { chain, ...resolveSecrets(names, chain, candidates) };
}

const whereText = (chain: readonly number[]) =>
  chain.length ? `${nodeRef(chain[0]!)} 及上级节点` : "组织树";
const setHint = (chain: readonly number[], name: string) =>
  `atrium secret set ${chain.length ? nodeRef(chain[0]!) : "o1"} ${name}`;

/** 建任务、改任务时查一遍：声明的凭据在归属部门的节点链上都要找得到。 */
export function checkTaskSecrets(
  db: DatabaseSync,
  start: number | null,
  names: readonly string[],
) {
  if (!names.length) return;
  const { chain, missing } = findSecrets(db, start, names);
  if (missing.length)
    throw new Problem(
      400,
      `secret: 在 ${whereText(chain)}上没有（或已归档）凭据 ${missing.join("、")}，先设好再派`,
      "usage",
      undefined,
      setHint(chain, missing[0]!),
    );
}

/**
 * 派活那一刻取值：按任务归属部门（没有取负责节点）的节点链找，读出值文件。
 * 缺了或读不到就报错不拉起（报错只带名称）；标记用过由拉起成功后的 markSecretsUsed 做。
 * extra 是执行者档案要的（t271 自定义端点的密钥）：同一套节点链找，值放进 as 这个环境变量。
 */
export function taskSecretValues(
  db: DatabaseSync,
  data: string,
  task: {
    id: number;
    ref: string;
    part_id: number | null;
    node_id: number | null;
  },
  extra: readonly { name: string; as: string; why: string }[] = [],
) {
  const declared = taskSecretNames(db, task.id);
  const names = [...new Set([...declared, ...extra.map((e) => e.name)])];
  if (!names.length) return null;
  const { chain, found, missing } = findSecrets(
    db,
    task.part_id ?? task.node_id,
    names,
  );
  if (missing.length) {
    const why = extra
      .filter((e) => missing.includes(e.name))
      .map((e) => `${e.name} 是${e.why}`);
    throw new Problem(
      409,
      `${task.ref} 要用的凭据 ${missing.join("、")} 在 ${whereText(chain)}上都没有（或已归档）${why.length ? `（${why.join("；")}）` : ""}；设好后再派`,
      "conflict",
      undefined,
      setHint(chain, missing[0]!),
    );
  }
  const env: Record<string, string> = {};
  for (const secret of found) {
    let value: string;
    try {
      value = readFileSync(valueFile(data, secret.id), "utf8");
    } catch {
      throw new Problem(
        409,
        `凭据 ${secret.name}（${nodeRef(secret.node_id)}）的值读不到；重新设一次`,
        "conflict",
        undefined,
        `atrium secret set ${nodeRef(secret.node_id)} ${secret.name}`,
      );
    }
    if (declared.includes(secret.name)) env[secret.name] = value;
    for (const e of extra) if (e.name === secret.name) env[e.as] = value;
  }
  return {
    env,
    ids: found.map((s) => s.id),
    used: found.map((s) => ({ name: s.name, node: nodeRef(s.node_id) })),
  };
}

/** 提示词里列的：声明了、现在找得到的名称与挂在哪（不读值）。 */
export function taskSecretList(
  db: DatabaseSync,
  task: { id: number; part_id: number | null; node_id: number | null },
) {
  const names = taskSecretNames(db, task.id);
  if (!names.length) return [];
  return findSecrets(db, task.part_id ?? task.node_id, names).found.map(
    (s) => ({ name: s.name, node: nodeRef(s.node_id) }),
  );
}

export function markSecretsUsed(
  db: DatabaseSync,
  ids: readonly number[],
  taskId: number,
  now = Date.now(),
) {
  if (!ids.length) return;
  db.prepare(
    `UPDATE node_secrets SET last_used_at=?,last_used_task=? WHERE id IN (${marks(ids)})`,
  ).run(now, taskId, ...ids);
}
