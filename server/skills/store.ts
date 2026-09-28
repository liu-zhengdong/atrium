import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  all,
  canEdit,
  nodeByAddress,
  nodePath,
  nodes,
  one,
  ref,
  transaction,
  type NodeRow,
} from "../org/model.ts";
import { validateReason } from "../org/validate.ts";
import {
  LIMITS,
  filesDiff,
  skillMeta,
  validateFiles,
  validateSkillSlug,
  type Files,
} from "./model.ts";
import { actsForUser } from "../../shared/user.ts";

/**
 * 组织技能的读写（#264 第 3b 步）：技能是组织资产，带只追加的修订历史；绑定挂在节点上。所有写入在一个 BEGIN IMMEDIATE 事务里完成。
 * 权限只看节点关系：你（u1）、技能 owner 节点或其祖先的 leader 能改；绑定看被绑节点。
 */

export type SkillRow = {
  id: number;
  slug: string;
  name: string;
  description: string;
  owner_node_id: number | null;
  rev: number;
  files: string;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
};
type RevisionRow = {
  id: number;
  skill_id: number;
  rev: number;
  author: string;
  reviewer: string | null;
  at: number;
  reason: string;
  source: string | null;
  snapshot: string;
};
type Snapshot = {
  slug: string;
  name: string;
  description: string;
  owner: string | null;
  archived: boolean;
  files: Files;
};

const rev = (value: number) => `r${value}`;

function parseRev(value: unknown, field: string): number {
  const match = /^r?(0|[1-9][0-9]*)$/.exec(String(value ?? "").trim());
  if (!match) throw new Problem(400, `${field} 应为修订号，如 r3`, "usage");
  return Number(match[1]);
}

function skillBySlug(db: DatabaseSync, slug: string): SkillRow {
  const row = one<SkillRow>(
    db,
    "SELECT * FROM org_skills WHERE slug=?",
    String(slug ?? "").trim(),
  );
  if (!row)
    throw new Problem(
      404,
      `技能 ${slug} 不存在`,
      "not_found",
      undefined,
      "atrium skill ls",
    );
  return row;
}

const filesOf = (row: { files: string }) => JSON.parse(row.files) as Files;

function snapshotOf(row: SkillRow): Snapshot {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    owner: row.owner_node_id === null ? null : ref(row.owner_node_id),
    archived: row.archived_at !== null,
    files: filesOf(row),
  };
}

function ownerLabel(list: NodeRow[], id: number | null) {
  if (id === null) return null;
  const node = list.find((n) => n.id === id);
  return node ? `${ref(id)} ${nodePath(list, node)}` : ref(id);
}

/** 能改技能：你，或 owner 节点及其祖先的 leader；没有 owner 的只有你。 */
function authorize(
  list: NodeRow[],
  ownerId: number | null,
  actor: string,
  what: string,
) {
  if (actsForUser(actor)) return;
  const owner = list.find((n) => n.id === ownerId);
  if (!owner || !canEdit(list, owner, actor))
    throw new Problem(
      403,
      `${what}无权限：${actor} 不是技能 owner ${owner ? ref(owner.id) : "（未指定，只有你能改）"} 的 leader 或祖先 leader`,
      "conflict",
    );
}

function liveNode(db: DatabaseSync, address: string, field: string): NodeRow {
  let node: NodeRow;
  try {
    node = nodeByAddress(db, String(address ?? "").trim());
  } catch (error) {
    if (error instanceof Problem)
      throw new Problem(
        error.statusCode === 404 ? 400 : error.statusCode,
        `${field}: ${error.message}`,
        "usage",
        error.candidates,
        "atrium org tree",
      );
    throw error;
  }
  if (node.archived_at !== null)
    throw new Problem(400, `${field}: 节点 ${ref(node.id)} 已归档`, "usage");
  return node;
}

function source(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Array.from(value).length > 300)
    throw new Problem(
      400,
      "source 应为 300 字以内的出处（任务号、链接等）",
      "usage",
    );
  return value.trim() || null;
}

function appendRevision(
  db: DatabaseSync,
  row: SkillRow,
  author: string,
  reason: string,
  from: string | null,
  reviewer: string | null = null,
) {
  db.prepare(
    "INSERT INTO org_skill_revisions(skill_id,rev,author,reviewer,at,reason,source,snapshot) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    row.id,
    row.rev,
    author,
    reviewer,
    row.updated_at,
    reason,
    from,
    JSON.stringify(snapshotOf(row)),
  );
}

// ---- 新建、编辑、回退 ----

export type AddSkillInput = {
  slug: unknown;
  name?: unknown;
  description?: unknown;
  owner?: unknown;
  files: unknown;
  reason: unknown;
  source?: unknown;
};

export function addSkill(
  db: DatabaseSync,
  input: AddSkillInput,
  actor: string,
) {
  return transaction(db, () => {
    const slug = validateSkillSlug(input.slug);
    const reason = validateReason(input.reason);
    const count = one<{ n: number }>(db, "SELECT count(*) n FROM org_skills")!;
    if (count.n >= LIMITS.skills)
      throw new Problem(400, `技能已达 ${LIMITS.skills} 个上限`, "usage");
    if (one(db, "SELECT 1 FROM org_skills WHERE slug=?", slug))
      throw new Problem(
        409,
        `技能 ${slug} 已存在`,
        "conflict",
        undefined,
        `atrium skill show ${slug}`,
      );
    const list = nodes(db);
    const owner =
      typeof input.owner === "string" && input.owner.trim()
        ? liveNode(db, input.owner, "owner")
        : (list.find((n) => n.parent_id === null) ?? null);
    authorize(list, owner?.id ?? null, actor, "新建技能");
    const meta = skillMeta(
      slug,
      validateFiles(input.files),
      typeof input.description === "string" ? input.description : undefined,
    );
    const files = validateFiles(meta.files);
    const name = displayName(input.name, slug);
    const now = Date.now();
    const id = Number(
      db
        .prepare(
          "INSERT INTO org_skills(slug,name,description,owner_node_id,rev,files,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?)",
        )
        .run(
          slug,
          name,
          meta.description,
          owner?.id ?? null,
          JSON.stringify(files),
          now,
          now,
        ).lastInsertRowid,
    );
    const row = one<SkillRow>(db, "SELECT * FROM org_skills WHERE id=?", id)!;
    appendRevision(db, row, actor, reason, source(input.source));
    return {
      slug,
      rev: rev(1),
      owner: ownerLabel(list, row.owner_node_id),
      files: Object.keys(files).length,
    };
  });
}

function displayName(value: unknown, fallback: string) {
  if (value === undefined || value === null || value === "") return fallback;
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || Array.from(text).length > LIMITS.name)
    throw new Problem(400, `name 应为 1–${LIMITS.name} 字`, "usage");
  return text;
}

export type EditSkillInput = {
  files?: unknown;
  name?: unknown;
  description?: unknown;
  owner?: unknown;
  archive?: unknown;
  rev?: unknown;
  reason: unknown;
  source?: unknown;
};

type Change = {
  files?: Files;
  name?: string;
  description?: string;
  owner?: number | null;
  archived?: boolean;
};

/** 写一次新修订；内容和元数据都没变时拒绝，免得历史里出现空修订。 */
function commit(
  db: DatabaseSync,
  row: SkillRow,
  change: Change,
  author: string,
  reason: string,
  from: string | null,
  reviewer: string | null = null,
): SkillRow {
  const next: SkillRow = {
    ...row,
    rev: row.rev + 1,
    updated_at: Date.now(),
    files: change.files ? JSON.stringify(change.files) : row.files,
    name: change.name ?? row.name,
    description: change.description ?? row.description,
    owner_node_id:
      change.owner === undefined ? row.owner_node_id : change.owner,
    archived_at:
      change.archived === undefined
        ? row.archived_at
        : change.archived
          ? (row.archived_at ?? Date.now())
          : null,
  };
  if (
    next.files === row.files &&
    next.name === row.name &&
    next.description === row.description &&
    next.owner_node_id === row.owner_node_id &&
    next.archived_at === row.archived_at
  )
    throw new Problem(400, "没有变化：内容与当前版相同", "usage");
  db.prepare(
    "UPDATE org_skills SET rev=?,files=?,name=?,description=?,owner_node_id=?,archived_at=?,updated_at=? WHERE id=?",
  ).run(
    next.rev,
    next.files,
    next.name,
    next.description,
    next.owner_node_id,
    next.archived_at,
    next.updated_at,
    row.id,
  );
  appendRevision(db, next, author, reason, from, reviewer);
  return next;
}

export function editSkill(
  db: DatabaseSync,
  slug: string,
  input: EditSkillInput,
  actor: string,
) {
  return transaction(db, () => {
    const row = skillBySlug(db, slug);
    const list = nodes(db);
    authorize(list, row.owner_node_id, actor, "修改技能");
    const reason = validateReason(input.reason);
    if (input.rev !== undefined && input.rev !== null && input.rev !== "") {
      const base = parseRev(input.rev, "rev");
      if (base !== row.rev)
        throw new Problem(
          409,
          `技能已是 ${rev(row.rev)}，你基于 ${rev(base)} 修改；先看变化`,
          "conflict",
          undefined,
          `atrium skill show ${row.slug} --history`,
        );
    }
    const change: Change = {};
    if (input.files !== undefined) {
      const meta = skillMeta(
        row.slug,
        validateFiles(input.files),
        typeof input.description === "string" ? input.description : undefined,
      );
      change.files = validateFiles(meta.files);
      change.description = meta.description;
    } else if (input.description !== undefined)
      throw new Problem(
        400,
        "description 写在 SKILL.md 的 frontmatter 里；改 SKILL.md 后连文件一起提交",
        "usage",
      );
    if (input.name !== undefined)
      change.name = displayName(input.name, row.slug);
    if (typeof input.owner === "string" && input.owner.trim()) {
      const owner = liveNode(db, input.owner, "owner");
      authorize(list, owner.id, actor, "把技能交给新 owner ");
      change.owner = owner.id;
    }
    if (input.archive !== undefined) change.archived = input.archive === true;
    const next = commit(db, row, change, actor, reason, source(input.source));
    return { slug: row.slug, before: rev(row.rev), rev: rev(next.rev) };
  });
}

function revisionAt(db: DatabaseSync, skill: SkillRow, at: number): Snapshot {
  const found = one<RevisionRow>(
    db,
    "SELECT * FROM org_skill_revisions WHERE skill_id=? AND rev=?",
    skill.id,
    at,
  );
  if (!found)
    throw new Problem(
      404,
      `技能 ${skill.slug} 没有修订 ${rev(at)}`,
      "not_found",
      undefined,
      `atrium skill show ${skill.slug} --history`,
    );
  return JSON.parse(found.snapshot) as Snapshot;
}

/** 回退：把旧修订的文件和元数据写成一个新修订，不抹掉历史。 */
export function revertSkill(
  db: DatabaseSync,
  slug: string,
  to: unknown,
  reasonText: unknown,
  actor: string,
) {
  return transaction(db, () => {
    const row = skillBySlug(db, slug);
    const list = nodes(db);
    authorize(list, row.owner_node_id, actor, "回退技能");
    const reason = validateReason(reasonText);
    const target = parseRev(to, "to");
    const old = revisionAt(db, row, target);
    const next = commit(
      db,
      row,
      { files: old.files, name: old.name, description: old.description },
      actor,
      reason,
      `回退到 ${rev(target)}`,
    );
    return {
      slug: row.slug,
      before: rev(row.rev),
      rev: rev(next.rev),
      to: rev(target),
    };
  });
}

// ---- 绑定 ----

export function bindSkill(
  db: DatabaseSync,
  slug: string,
  address: string,
  actor: string,
  unbind = false,
) {
  return transaction(db, () => {
    const row = skillBySlug(db, slug);
    const list = nodes(db);
    const node = liveNode(db, address, "node");
    if (!canEdit(list, node, actor))
      throw new Problem(
        403,
        `${unbind ? "解绑" : "绑定"}无权限：${actor} 不是 ${ref(node.id)} 的 leader 或祖先 leader`,
        "conflict",
      );
    const where = `${ref(node.id)} ${nodePath(list, node)}`;
    if (unbind) {
      const result = db
        .prepare(
          "DELETE FROM org_skill_bindings WHERE skill_id=? AND node_id=?",
        )
        .run(row.id, node.id);
      if (!result.changes)
        throw new Problem(
          404,
          `${row.slug} 没有绑在 ${where}`,
          "not_found",
          undefined,
          `atrium skill show ${row.slug}`,
        );
      return { slug: row.slug, node: where, bound: false };
    }
    if (row.archived_at !== null)
      throw new Problem(400, `技能 ${row.slug} 已归档，不能绑定`, "usage");
    if (
      one(
        db,
        "SELECT 1 FROM org_skill_bindings WHERE skill_id=? AND node_id=?",
        row.id,
        node.id,
      )
    )
      throw new Problem(
        409,
        `${row.slug} 已绑在 ${where}`,
        "conflict",
        undefined,
        `atrium skill show ${row.slug}`,
      );
    db.prepare(
      "INSERT INTO org_skill_bindings(skill_id,node_id,created_by,created_at) VALUES(?,?,?,?)",
    ).run(row.id, node.id, actor, Date.now());
    return { slug: row.slug, node: where, bound: true };
  });
}

// ---- 读取 ----

function bindingsOf(db: DatabaseSync, list: NodeRow[], skillId: number) {
  return all<{ node_id: number }>(
    db,
    "SELECT node_id FROM org_skill_bindings WHERE skill_id=? ORDER BY node_id LIMIT 500",
    skillId,
  ).map((b) => ownerLabel(list, b.node_id)!);
}

export function listSkills(db: DatabaseSync, includeArchived = false) {
  const list = nodes(db);
  return all<SkillRow>(
    db,
    `SELECT * FROM org_skills ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY slug LIMIT ?`,
    LIMITS.skills,
  ).map((row) => ({
    slug: row.slug,
    name: row.name,
    description: row.description,
    rev: rev(row.rev),
    owner: ownerLabel(list, row.owner_node_id),
    bound: bindingsOf(db, list, row.id),
    files: Object.keys(filesOf(row)).length,
    archived: row.archived_at !== null,
  }));
}

export function showSkill(db: DatabaseSync, slug: string) {
  const row = skillBySlug(db, slug);
  const list = nodes(db);
  const files = filesOf(row);
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    rev: rev(row.rev),
    owner: ownerLabel(list, row.owner_node_id),
    archived: row.archived_at !== null,
    bound: bindingsOf(db, list, row.id),
    files,
    sizes: Object.fromEntries(
      Object.entries(files).map(([path, text]) => [
        path,
        Buffer.byteLength(text),
      ]),
    ),
  };
}

/** 修订历史（新→旧，有界分页）；给 rev 时显示该修订与上一版的差异。 */
export function skillHistory(
  db: DatabaseSync,
  slug: string,
  query: { rev?: string; before?: string; limit?: number } = {},
) {
  const row = skillBySlug(db, slug);
  if (query.rev) {
    const at = parseRev(query.rev, "rev");
    const after = revisionAt(db, row, at);
    const before = at > 1 ? revisionAt(db, row, at - 1) : undefined;
    const meta = one<RevisionRow>(
      db,
      "SELECT * FROM org_skill_revisions WHERE skill_id=? AND rev=?",
      row.id,
      at,
    )!;
    return {
      slug: row.slug,
      revision: { ...revisionView(meta) },
      diff: filesDiff(before?.files ?? {}, after.files),
      meta: (["name", "description", "owner", "archived"] as const)
        .filter((key) => before && before[key] !== after[key])
        .map((key) => ({
          field: key,
          before: before![key],
          after: after[key],
        })),
    };
  }
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 20) || 20, 1), 100);
  const before = query.before ? parseRev(query.before, "before") : undefined;
  const items = all<RevisionRow>(
    db,
    `SELECT * FROM org_skill_revisions WHERE skill_id=? ${before === undefined ? "" : "AND rev<?"} ORDER BY rev DESC LIMIT ?`,
    ...(before === undefined
      ? [row.id, limit + 1]
      : [row.id, before, limit + 1]),
  );
  return {
    slug: row.slug,
    items: items.slice(0, limit).map(revisionView),
    has_more: items.length > limit,
  };
}

function revisionView(r: RevisionRow) {
  return {
    rev: rev(r.rev),
    author: r.author,
    reviewer: r.reviewer,
    at: r.at,
    reason: r.reason,
    source: r.source,
  };
}
