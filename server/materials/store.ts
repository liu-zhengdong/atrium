import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
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
  linkRef,
  materialRef,
  PAGE_DEFAULT,
  PAGE_MAX,
  parseMaterialRef,
  pathProblem,
  purgeVerdict,
  READS_KEPT,
  staleVerdict,
  type Link,
  type LinkKind,
  type Stale,
  type Upload,
} from "./model.ts";
import { hasTable, marks } from "../sqlite.ts";

/**
 * 资料的存储：四张新表（materials、material_versions、material_reads、material_links），
 * 文件放数据目录 materials/mN/vK/ 下，每个版本一份、改了不覆盖旧版。旧运行时的 attachments 表不读不写。
 * 判定在 model.ts，这里只取事实、落库、读写文件。
 */

export function ensureMaterialTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('file','dir')),
    name TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    files INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    superseded_by INTEGER,
    last_read_at INTEGER, last_read_by TEXT,
    archived_at INTEGER, archived_by TEXT, archive_note TEXT,
    keep_at INTEGER, keep_by TEXT, keep_note TEXT,
    hinted_at INTEGER, purge_asked_at INTEGER);
  CREATE INDEX IF NOT EXISTS materials_node ON materials(node_id,archived_at,id);
  CREATE INDEX IF NOT EXISTS materials_archived ON materials(archived_at) WHERE archived_at IS NOT NULL;
  CREATE TABLE IF NOT EXISTS material_versions (
    material_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    files INTEGER NOT NULL,
    digest TEXT NOT NULL,
    manifest TEXT NOT NULL,
    note TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(material_id,version));
  CREATE TABLE IF NOT EXISTS material_reads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    reader TEXT NOT NULL,
    task_id INTEGER,
    at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS material_reads_material ON material_reads(material_id,id);
  CREATE TABLE IF NOT EXISTS material_links (
    material_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('task','point','decision')),
    target_id INTEGER NOT NULL,
    PRIMARY KEY(material_id,kind,target_id));`);
}

export type MaterialRow = {
  id: number;
  node_id: number;
  kind: "file" | "dir";
  name: string;
  note: string;
  version: number;
  bytes: number;
  files: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  superseded_by: number | null;
  last_read_at: number | null;
  last_read_by: string | null;
  archived_at: number | null;
  archived_by: string | null;
  archive_note: string | null;
  keep_at: number | null;
  keep_by: string | null;
  keep_note: string | null;
  hinted_at: number | null;
  purge_asked_at: number | null;
};
export type ManifestEntry = { path: string; size: number; sha256: string };
type VersionRow = {
  material_id: number;
  version: number;
  bytes: number;
  files: number;
  digest: string;
  manifest: string;
  note: string | null;
  created_by: string;
  created_at: number;
};

export const materialsRoot = (data: string) => join(data, "materials");
export const versionDir = (data: string, id: number, version: number) =>
  join(materialsRoot(data), materialRef(id), `v${version}`);

/** 读者的叫法：秘书、aN，或任务 tN（执行者 material get）。 */
export const readerWord = (reader: string) =>
  reader === "secretary" ? "秘书" : reader;

export function materialView(row: MaterialRow, list?: readonly NodeRow[]) {
  const node = list?.find((n) => n.id === row.node_id);
  return {
    ref: materialRef(row.id),
    node: nodeRef(row.node_id),
    node_name: node?.name ?? null,
    kind: row.kind,
    name: row.name,
    note: row.note,
    version: row.version,
    bytes: row.bytes,
    files: row.files,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    superseded_by:
      row.superseded_by === null ? null : materialRef(row.superseded_by),
    last_read_at: row.last_read_at,
    last_read_by: row.last_read_by,
    archived: row.archived_at !== null,
    archived_at: row.archived_at,
    archive_note: row.archive_note,
    keep_at: row.keep_at,
    keep_note: row.keep_note,
  };
}
export type MaterialView = ReturnType<typeof materialView>;

export function getMaterial(db: DatabaseSync, reference: unknown): MaterialRow {
  const id = parseMaterialRef(reference);
  const row = one<MaterialRow>(db, "SELECT * FROM materials WHERE id=?", id);
  if (!row)
    throw new Problem(
      404,
      `资料 ${materialRef(id)} 不存在`,
      "not_found",
      undefined,
      "atrium material ls",
    );
  return row;
}

/** 关联的目标都得在：任务、要点、决定各查一次（IN），不在循环里查库。 */
function checkLinks(db: DatabaseSync, links: readonly Link[]) {
  const tables: Record<LinkKind, string> = {
    task: "tasks",
    point: "org_points",
    decision: "decisions",
  };
  for (const kind of ["task", "point", "decision"] as const) {
    const ids = links.filter((l) => l.kind === kind).map((l) => l.id);
    if (!ids.length) continue;
    const found = new Set(
      hasTable(db, tables[kind])
        ? all<{ id: number }>(
            db,
            `SELECT id FROM ${tables[kind]} WHERE id IN (${marks(ids)})`,
            ...ids,
          ).map((r) => r.id)
        : [],
    );
    const missing = ids.find((id) => !found.has(id));
    if (missing !== undefined)
      throw new Problem(
        404,
        `--for: ${linkRef({ kind, id: missing })} 不存在`,
        "not_found",
      );
  }
}

const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** 把一个版本的文件写进 vK/：先写临时目录再改名，写一半失败不留半截。 */
function writeVersion(
  data: string,
  id: number,
  version: number,
  upload: Upload,
) {
  const target = versionDir(data, id, version);
  const temp = `${target}.tmp-${randomBytes(4).toString("hex")}`;
  try {
    for (const file of upload.files) {
      // 已过 pathProblem；落盘前再防一次。
      if (pathProblem(file.path)) throw new Error(`坏路径 ${file.path}`);
      const path = join(temp, ...file.path.split("/"));
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, file.bytes, { mode: 0o600 });
    }
    // 库是准的：同号的目录只可能是上次写了没记上账的残留。
    rmSync(target, { recursive: true, force: true });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

export type AddResult = {
  material: MaterialView;
  /** new：新资料；version：已有资料加了新版本；unchanged：内容和当前版本一样，没加。 */
  outcome: "new" | "version" | "unchanged";
  skipped?: number;
};

/**
 * 加资料：同一节点上同名、没归档的资料加新版本（内容一样就不加），否则建新的 mN；
 * --supersedes 把旧资料标成被这份取代。库与文件在同一事务里，文件写失败就回滚。
 */
export function addMaterial(
  db: DatabaseSync,
  data: string,
  upload: Upload,
  by: string,
  now = Date.now(),
): AddResult {
  const node = nodeByAddress(db, upload.node);
  if (node.archived_at !== null)
    throw new Problem(
      409,
      `${nodeRef(node.id)} 已归档，不能再挂资料`,
      "conflict",
    );
  const manifest: ManifestEntry[] = upload.files.map((f) => ({
    path: f.path,
    size: f.bytes.length,
    sha256: sha(f.bytes),
  }));
  const digest = sha(JSON.stringify(manifest.map((m) => [m.path, m.sha256])));
  return transaction(db, () => {
    checkLinks(db, upload.links);
    const existing = one<MaterialRow>(
      db,
      "SELECT * FROM materials WHERE node_id=? AND name=? AND archived_at IS NULL ORDER BY id DESC LIMIT 1",
      node.id,
      upload.name,
    );
    if (existing && existing.kind !== upload.kind)
      throw new Problem(
        409,
        `${nodeRef(node.id)} 上已有同名的${existing.kind === "dir" ? "目录" : "文件"}资料 ${materialRef(existing.id)}；换个 --name，或先 atrium material archive ${materialRef(existing.id)}`,
        "conflict",
      );
    if (existing) {
      const current = one<{ digest: string }>(
        db,
        "SELECT digest FROM material_versions WHERE material_id=? AND version=?",
        existing.id,
        existing.version,
      );
      if (current?.digest === digest) {
        linkAll(db, existing.id, upload.links);
        supersede(db, existing.id, upload.supersedes);
        return {
          material: materialView(existing, [node]),
          outcome: "unchanged",
        };
      }
    }
    if (upload.note === null && !existing)
      throw new Problem(
        400,
        "--note: 新资料要写一句话说明是什么（清单里靠它判断要不要取）",
        "usage",
      );
    let id: number;
    let version: number;
    if (existing) {
      id = existing.id;
      version = existing.version + 1;
      db.prepare(
        "UPDATE materials SET version=?,bytes=?,files=?,updated_at=?,note=COALESCE(?,note) WHERE id=?",
      ).run(version, upload.size, manifest.length, now, upload.note, id);
    } else {
      version = 1;
      id = Number(
        db
          .prepare(
            "INSERT INTO materials(node_id,kind,name,note,version,bytes,files,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            node.id,
            upload.kind,
            upload.name,
            upload.note ?? "",
            version,
            upload.size,
            manifest.length,
            by,
            now,
            now,
          ).lastInsertRowid,
      );
    }
    supersede(db, id, upload.supersedes);
    db.prepare(
      "INSERT INTO material_versions(material_id,version,bytes,files,digest,manifest,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      version,
      upload.size,
      manifest.length,
      digest,
      JSON.stringify(manifest),
      existing ? upload.note : null,
      by,
      now,
    );
    linkAll(db, id, upload.links);
    writeVersion(data, id, version, upload);
    const row = getMaterial(db, materialRef(id));
    return {
      material: materialView(row, [node]),
      outcome: existing ? "version" : "new",
    };
  });
}

/** 旧资料标成被 id 取代（旧的留着，清理线索会提它）。 */
function supersede(db: DatabaseSync, id: number, old: number | null) {
  if (old === null) return;
  if (old === id) throw new Problem(400, "--supersedes: 不能取代自己", "usage");
  const row = getMaterial(db, materialRef(old));
  db.prepare("UPDATE materials SET superseded_by=? WHERE id=?").run(id, row.id);
}

function linkAll(db: DatabaseSync, id: number, links: readonly Link[]) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO material_links(material_id,kind,target_id) VALUES (?,?,?)",
  );
  for (const link of links) insert.run(id, link.kind, link.id);
}

/** 关联是否都已结束：按类别各查一次；任务结束、要点删了、决定被推翻或不在了都算结束。 */
export function linkFacts(
  db: DatabaseSync,
  ids: readonly number[],
): Map<number, { ref: string; ended: boolean }[]> {
  const result = new Map<number, { ref: string; ended: boolean }[]>();
  if (!ids.length) return result;
  const links = all<{ material_id: number; kind: LinkKind; target_id: number }>(
    db,
    `SELECT material_id,kind,target_id FROM material_links WHERE material_id IN (${marks(ids)}) ORDER BY material_id,kind,target_id`,
    ...ids,
  );
  const open = (kind: LinkKind, sql: string, table: string) => {
    const targets = [
      ...new Set(links.filter((l) => l.kind === kind).map((l) => l.target_id)),
    ];
    if (!targets.length || !hasTable(db, table)) return new Set<number>();
    return new Set(
      all<{ id: number }>(
        db,
        `${sql} AND id IN (${marks(targets)})`,
        ...targets,
      ).map((r) => r.id),
    );
  };
  const live: Record<LinkKind, Set<number>> = {
    task: open(
      "task",
      "SELECT id FROM tasks WHERE status NOT IN ('done','failed','cancelled')",
      "tasks",
    ),
    point: open("point", "SELECT id FROM org_points WHERE 1=1", "org_points"),
    decision: open(
      "decision",
      "SELECT id FROM decisions WHERE superseded_by IS NULL",
      "decisions",
    ),
  };
  for (const link of links) {
    const list = result.get(link.material_id) ?? [];
    list.push({
      ref: linkRef({ kind: link.kind, id: link.target_id }),
      ended: !live[link.kind].has(link.target_id),
    });
    result.set(link.material_id, list);
  }
  return result;
}

const staleOf = (
  row: MaterialRow,
  links: Map<number, { ended: boolean }[]>,
  now: number,
) =>
  staleVerdict(
    { ...row, links: (links.get(row.id) ?? []).map((l) => l.ended) },
    now,
  );

/** 一份资料的全貌：版本（新的在前）、最近的读取、关联与清理线索。 */
export function showMaterial(
  db: DatabaseSync,
  reference: unknown,
  now = Date.now(),
) {
  const row = getMaterial(db, reference);
  const versions = all<VersionRow>(
    db,
    "SELECT * FROM material_versions WHERE material_id=? ORDER BY version DESC LIMIT 50",
    row.id,
  ).map((v) => ({
    version: v.version,
    bytes: v.bytes,
    files: v.files,
    note: v.note,
    created_by: v.created_by,
    created_at: v.created_at,
  }));
  const reads = all<{
    version: number;
    reader: string;
    at: number;
  }>(
    db,
    "SELECT version,reader,at FROM material_reads WHERE material_id=? ORDER BY id DESC LIMIT 20",
    row.id,
  );
  const links = linkFacts(db, [row.id]);
  return {
    ...materialView(row, nodes(db)),
    versions,
    reads,
    links: links.get(row.id) ?? [],
    stale: staleOf(row, links, now),
    supersedes: all<{ id: number }>(
      db,
      "SELECT id FROM materials WHERE superseded_by=? ORDER BY id LIMIT 20",
      row.id,
    ).map((r) => materialRef(r.id)),
  };
}

/** 列资料：新的在前，按 id 分页；缺省不含归档的，--archived 只列归档的。 */
export function listMaterials(
  db: DatabaseSync,
  query: {
    node?: string;
    archived?: boolean;
    before?: string;
    limit?: string;
  },
) {
  const where: string[] = [
    query.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL",
  ];
  const args: SQLInputValue[] = [];
  const list = nodes(db);
  if (query.node) {
    where.push("node_id=?");
    args.push(nodeByAddress(db, query.node).id);
  }
  if (query.before) {
    where.push("id<?");
    args.push(parseMaterialRef(query.before, "--before"));
  }
  let limit = PAGE_DEFAULT;
  if (query.limit !== undefined && query.limit !== "") {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX)
      throw new Problem(400, `--limit: 应为 1～${PAGE_MAX} 的整数`, "usage");
  }
  const rows = all<MaterialRow>(
    db,
    `SELECT * FROM materials WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`,
    ...args,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  return {
    materials: page.map((r) => materialView(r, list)),
    next_before: rows.length > limit ? materialRef(page.at(-1)!.id) : null,
  };
}

function versionRow(db: DatabaseSync, row: MaterialRow, version?: unknown) {
  let v = row.version;
  if (version !== undefined && version !== null && version !== "") {
    v = Number(String(version).replace(/^v/, ""));
    if (!Number.isInteger(v) || v < 1)
      throw new Problem(400, "--version: 应为版本号，如 2 或 v2", "usage");
  }
  const found = one<VersionRow>(
    db,
    "SELECT * FROM material_versions WHERE material_id=? AND version=?",
    row.id,
    v,
  );
  if (!found)
    throw new Problem(
      404,
      `${materialRef(row.id)} 没有版本 v${v}`,
      "not_found",
      undefined,
      `atrium material show ${materialRef(row.id)}`,
    );
  return found;
}

/**
 * 取资料的清单并记一次读取（get 的第一步）。读者：leader 令牌是 aN，执行者带自己的任务 tN，其余是秘书。
 * 已归档的照样能取（可恢复），但不进清单和提示词。
 */
export function openMaterial(
  db: DatabaseSync,
  reference: unknown,
  input: { version?: unknown; reader: string; task: number | null },
  now = Date.now(),
) {
  const row = getMaterial(db, reference);
  const version = versionRow(db, row, input.version);
  let reader = input.reader;
  let task: number | null = null;
  if (
    input.task !== null &&
    one(db, "SELECT 1 AS ok FROM tasks WHERE id=?", input.task)
  ) {
    task = input.task;
    reader = `t${task}`;
  }
  transaction(db, () => {
    db.prepare(
      "INSERT INTO material_reads(material_id,version,reader,task_id,at) VALUES (?,?,?,?,?)",
    ).run(row.id, version.version, reader, task, now);
    // 只留最近 READS_KEPT 条。
    db.prepare(
      `DELETE FROM material_reads WHERE material_id=? AND id <= (
        SELECT id FROM material_reads WHERE material_id=? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
    ).run(row.id, row.id, READS_KEPT);
    db.prepare(
      "UPDATE materials SET last_read_at=?,last_read_by=? WHERE id=?",
    ).run(now, reader, row.id);
  });
  return {
    ref: materialRef(row.id),
    kind: row.kind,
    name: row.name,
    version: version.version,
    bytes: version.bytes,
    files: JSON.parse(version.manifest) as ManifestEntry[],
  };
}

/** 读一个文件：只认清单里有的路径，落到版本目录外（软链接、改名）的一律拒绝。 */
export function readMaterialFile(
  db: DatabaseSync,
  data: string,
  reference: unknown,
  version: unknown,
  path: unknown,
): { path: string; size: number; data: string } {
  const row = getMaterial(db, reference);
  const v = versionRow(db, row, version);
  const text = typeof path === "string" ? path : "";
  const problem = pathProblem(text);
  if (problem) throw new Problem(400, `path: ${problem}`, "usage");
  const manifest = JSON.parse(v.manifest) as ManifestEntry[];
  if (!manifest.some((m) => m.path === text))
    throw new Problem(
      404,
      `${materialRef(row.id)} v${v.version} 里没有 ${text}`,
      "not_found",
    );
  const base = versionDir(data, row.id, v.version);
  const file = join(base, ...text.split("/"));
  let bytes: Buffer;
  try {
    const stat = lstatSync(file);
    const real = realpathSync(file);
    if (!stat.isFile() || !real.startsWith(realpathSync(base) + sep))
      throw new Error("越界");
    bytes = readFileSync(real);
  } catch {
    throw new Problem(
      404,
      `${materialRef(row.id)} v${v.version} 的 ${text} 在数据目录里找不到了`,
      "not_found",
    );
  }
  return { path: text, size: bytes.length, data: bytes.toString("base64") };
}

/** 归档、恢复、留下：归档的不进清单与提示词，可恢复；留下写原因，之后清理线索不再提。 */
export function setMaterialState(
  db: DatabaseSync,
  reference: unknown,
  action: "archive" | "restore" | "keep",
  note: string | null,
  by: string,
  now = Date.now(),
) {
  const row = getMaterial(db, reference);
  const m = materialRef(row.id);
  if (action === "archive") {
    if (row.archived_at !== null)
      throw new Problem(409, `${m} 已经归档了`, "conflict");
    db.prepare(
      "UPDATE materials SET archived_at=?,archived_by=?,archive_note=?,purge_asked_at=NULL WHERE id=?",
    ).run(now, by, note, row.id);
  } else if (action === "restore") {
    if (row.archived_at === null)
      throw new Problem(409, `${m} 没有归档`, "conflict");
    const clash = one<{ id: number }>(
      db,
      "SELECT id FROM materials WHERE node_id=? AND name=? AND archived_at IS NULL AND id<>?",
      row.node_id,
      row.name,
      row.id,
    );
    if (clash)
      throw new Problem(
        409,
        `${nodeRef(row.node_id)} 上已有同名的 ${materialRef(clash.id)}；先归档它再恢复 ${m}`,
        "conflict",
      );
    db.prepare(
      "UPDATE materials SET archived_at=NULL,archived_by=NULL,archive_note=?,hinted_at=NULL,purge_asked_at=NULL WHERE id=?",
    ).run(note, row.id);
  } else {
    if (note === null)
      throw new Problem(
        400,
        "--note: 留下要写一句原因（之后清理线索不再提它）",
        "usage",
      );
    db.prepare(
      "UPDATE materials SET keep_at=?,keep_by=?,keep_note=? WHERE id=?",
    ).run(now, by, note, row.id);
  }
  return materialView(getMaterial(db, m), nodes(db));
}

/** 真删（只有用户）：库里的行与全部版本的文件一起删。 */
export function removeMaterial(
  db: DatabaseSync,
  data: string,
  reference: unknown,
) {
  const row = getMaterial(db, reference);
  const view = materialView(row, nodes(db));
  transaction(db, () => {
    for (const table of [
      "material_versions",
      "material_reads",
      "material_links",
    ])
      db.prepare(`DELETE FROM ${table} WHERE material_id=?`).run(row.id);
    db.prepare(
      "UPDATE materials SET superseded_by=NULL WHERE superseded_by=?",
    ).run(row.id);
    db.prepare("DELETE FROM materials WHERE id=?").run(row.id);
  });
  rmSync(join(materialsRoot(data), materialRef(row.id)), {
    recursive: true,
    force: true,
  });
  return view;
}

export type StaleItem = MaterialView & { stale: Stale };

/** 某些节点上疑似没用的资料（nodeIds 为 null 是全部）；一次读出候选，关联按类别批量查。 */
export function staleMaterials(
  db: DatabaseSync,
  nodeIds: readonly number[] | null,
  now = Date.now(),
): (StaleItem & { hinted_at: number | null })[] {
  const scope = nodeIds === null ? "" : ` AND node_id IN (${marks(nodeIds)})`;
  if (nodeIds !== null && !nodeIds.length) return [];
  const rows = all<MaterialRow>(
    db,
    `SELECT * FROM materials WHERE archived_at IS NULL AND keep_at IS NULL${scope} ORDER BY id LIMIT 2000`,
    ...(nodeIds ?? []),
  );
  const links = linkFacts(
    db,
    rows.map((r) => r.id),
  );
  const list = nodes(db);
  const result: (StaleItem & { hinted_at: number | null })[] = [];
  for (const row of rows) {
    const stale = staleOf(row, links, now);
    if (stale)
      result.push({
        ...materialView(row, list),
        stale,
        hinted_at: row.hinted_at,
      });
  }
  return result;
}

/**
 * 可以真删的（归档超过一年且大于 10 MB，按全部版本加起来算）：缺省只要还没问过用户的（发线索用），
 * asked 为 true 时连问过的一起列（material ls --stale 给人看）。
 */
export function purgeMaterials(
  db: DatabaseSync,
  now = Date.now(),
  asked = false,
) {
  const list = nodes(db);
  return all<MaterialRow & { total_bytes: number }>(
    db,
    `SELECT m.*, COALESCE(SUM(v.bytes),0) AS total_bytes FROM materials m
      LEFT JOIN material_versions v ON v.material_id=m.id
      WHERE m.archived_at IS NOT NULL${asked ? "" : " AND m.purge_asked_at IS NULL"}
      GROUP BY m.id ORDER BY m.archived_at LIMIT 2000`,
  )
    .filter((row) =>
      purgeVerdict(
        { ...row, bytes: row.total_bytes, purge_asked_at: null },
        now,
      ),
    )
    .map((row) => ({
      ...materialView(row, list),
      total_bytes: row.total_bytes,
    }));
}

export function markHinted(
  db: DatabaseSync,
  ids: readonly number[],
  column: "hinted_at" | "purge_asked_at",
  now: number,
) {
  if (!ids.length) return;
  db.prepare(
    `UPDATE materials SET ${column}=? WHERE id IN (${marks(ids)})`,
  ).run(now, ...ids);
}

/** 全景节点页「资料」页签：本块的资料（没归档的在前），带清理线索。 */
export function materialsForNode(
  db: DatabaseSync,
  nodeId: number,
  now = Date.now(),
) {
  if (!hasTable(db, "materials")) return [];
  const rows = all<MaterialRow>(
    db,
    "SELECT * FROM materials WHERE node_id=? ORDER BY archived_at IS NOT NULL, id DESC LIMIT 100",
    nodeId,
  );
  const links = linkFacts(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => ({
    ...materialView(row),
    stale: staleOf(row, links, now),
  }));
}
