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
import { taskRef } from "../tasks/ledger-model.ts";
import {
  LIMITS,
  filesDiff,
  mergeFiles,
  sameFiles,
  skillMeta,
  validateFiles,
  validateSkillSlug,
  type Files,
} from "./model.ts";
import { actsForUser } from "../../shared/user.ts";

/**
 * 组织技能的读写（#264 第 3b 步）：技能是组织资产，带只追加的修订历史；绑定挂在节点上；
 * 执行者改了挂载副本时由收尾生成提议，审核通过才写成新修订。所有写入在一个 BEGIN IMMEDIATE 事务里完成。
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
export type ProposalRow = {
  id: number;
  skill_id: number;
  task_id: number;
  base_rev: number;
  files: string;
  reason: string;
  status: "pending" | "accepted" | "rejected";
  created_at: number;
  decided_by: string | null;
  decided_at: number | null;
  decision_reason: string | null;
  result_rev: number | null;
};
type Snapshot = {
  slug: string;
  name: string;
  description: string;
  owner: string | null;
  archived: boolean;
  files: Files;
};

export const proposalRef = (id: number) => `p${id}`;
const rev = (value: number) => `r${value}`;

function parseRev(value: unknown, field: string): number {
  const match = /^r?(0|[1-9][0-9]*)$/.exec(String(value ?? "").trim());
  if (!match) throw new Problem(400, `${field} 应为修订号，如 r3`, "usage");
  return Number(match[1]);
}

export function skillBySlug(db: DatabaseSync, slug: string): SkillRow {
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

function proposalById(db: DatabaseSync, value: string): ProposalRow {
  const match = /^p?([1-9][0-9]*)$/.exec(String(value ?? "").trim());
  if (!match) throw new Problem(400, "提议应写成 p1 这样的短号", "usage");
  const row = one<ProposalRow>(
    db,
    "SELECT * FROM org_skill_proposals WHERE id=?",
    Number(match[1]),
  );
  if (!row)
    throw new Problem(
      404,
      `提议 ${value} 不存在`,
      "not_found",
      undefined,
      "atrium skill proposals",
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
  /** 手工合并某个提议后写回：该提议标为已采纳。 */
  proposal?: unknown;
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
          `atrium skill history ${row.slug}`,
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
    let proposal: ProposalRow | undefined;
    if (
      input.proposal !== undefined &&
      input.proposal !== null &&
      input.proposal !== ""
    ) {
      proposal = proposalById(db, String(input.proposal));
      if (proposal.skill_id !== row.id)
        throw new Problem(
          400,
          `proposal: ${proposalRef(proposal.id)} 不是 ${row.slug} 的提议`,
          "usage",
        );
      if (proposal.status !== "pending")
        throw new Problem(
          409,
          `proposal: ${proposalRef(proposal.id)} 已${proposal.status === "accepted" ? "采纳" : "驳回"}`,
          "conflict",
        );
    }
    const next = commit(
      db,
      row,
      change,
      proposal ? taskRef(proposal.task_id) : actor,
      reason,
      source(input.source) ?? (proposal ? proposalRef(proposal.id) : null),
      proposal ? actor : null,
    );
    if (proposal) decide(db, proposal, "accepted", actor, reason, next.rev);
    return {
      slug: row.slug,
      before: rev(row.rev),
      rev: rev(next.rev),
      ...(proposal ? { proposal: proposalRef(proposal.id) } : {}),
    };
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
      `atrium skill history ${skill.slug}`,
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
  const pending = new Map(
    all<{ skill_id: number; n: number }>(
      db,
      "SELECT skill_id, count(*) n FROM org_skill_proposals WHERE status='pending' GROUP BY skill_id",
    ).map((r) => [r.skill_id, r.n]),
  );
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
    pending: pending.get(row.id) ?? 0,
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
    pending: all<ProposalRow>(
      db,
      "SELECT * FROM org_skill_proposals WHERE skill_id=? AND status='pending' ORDER BY id LIMIT 20",
      row.id,
    ).map((p) => ({
      ref: proposalRef(p.id),
      task: taskRef(p.task_id),
      base: rev(p.base_rev),
    })),
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

// ---- 修订提议 ----

export function listProposals(
  db: DatabaseSync,
  query: { status?: string; limit?: number } = {},
) {
  const status = query.status ?? "pending";
  if (!["pending", "accepted", "rejected", "all"].includes(status))
    throw new Problem(
      400,
      "status 只能是 pending、accepted、rejected 或 all",
      "usage",
    );
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50) || 50, 1), 200);
  return all<ProposalRow & { slug: string; current: number }>(
    db,
    `SELECT p.*, s.slug slug, s.rev current FROM org_skill_proposals p JOIN org_skills s ON s.id=p.skill_id
     ${status === "all" ? "" : "WHERE p.status=?"} ORDER BY p.id DESC LIMIT ?`,
    ...(status === "all" ? [limit] : [status, limit]),
  ).map((p) => ({
    ref: proposalRef(p.id),
    skill: p.slug,
    task: taskRef(p.task_id),
    base: rev(p.base_rev),
    current: rev(p.current),
    status: p.status,
    reason: p.reason,
    created_at: p.created_at,
    result: p.result_rev === null ? null : rev(p.result_rev),
  }));
}

export function showProposal(db: DatabaseSync, value: string) {
  const p = proposalById(db, value);
  const skill = one<SkillRow>(
    db,
    "SELECT * FROM org_skills WHERE id=?",
    p.skill_id,
  )!;
  const base = revisionAt(db, skill, p.base_rev);
  return {
    ref: proposalRef(p.id),
    skill: skill.slug,
    task: taskRef(p.task_id),
    base: rev(p.base_rev),
    current: rev(skill.rev),
    status: p.status,
    reason: p.reason,
    decided_by: p.decided_by,
    decision_reason: p.decision_reason,
    result: p.result_rev === null ? null : rev(p.result_rev),
    files: filesOf(p),
    diff: filesDiff(base.files, filesOf(p)),
  };
}

function decide(
  db: DatabaseSync,
  p: ProposalRow,
  status: "accepted" | "rejected",
  actor: string,
  reason: string,
  result: number | null,
) {
  db.prepare(
    "UPDATE org_skill_proposals SET status=?,decided_by=?,decided_at=?,decision_reason=?,result_rev=? WHERE id=? AND status='pending'",
  ).run(status, actor, Date.now(), reason, result, p.id);
}

/**
 * 采纳：基于的版本还是当前版就直接写；已被别的修订更新时按文件三方合并，冲突就拒绝并留给审核人手工合并
 * （改好后 `skill edit <slug> <目录> --proposal pN` 写回并标为采纳）。新修订的作者记任务号，审核人另记。
 */
export function acceptProposal(
  db: DatabaseSync,
  value: string,
  reasonText: unknown,
  actor: string,
) {
  return transaction(db, () => {
    const p = proposalById(db, value);
    if (p.status !== "pending")
      throw new Problem(
        409,
        `${proposalRef(p.id)} 已${p.status === "accepted" ? "采纳" : "驳回"}`,
        "conflict",
      );
    const row = one<SkillRow>(
      db,
      "SELECT * FROM org_skills WHERE id=?",
      p.skill_id,
    )!;
    authorize(nodes(db), row.owner_node_id, actor, "审核技能提议");
    const reason =
      reasonText === undefined || reasonText === null || reasonText === ""
        ? `采纳 ${proposalRef(p.id)}：${p.reason}`.slice(0, 500)
        : validateReason(reasonText);
    const theirs = filesOf(p);
    let files = theirs;
    let merged = false;
    if (p.base_rev !== row.rev) {
      const base = revisionAt(db, row, p.base_rev).files;
      const result = mergeFiles(base, filesOf(row), theirs);
      if (result.conflicts.length)
        throw new Problem(
          409,
          `${proposalRef(p.id)} 基于 ${rev(p.base_rev)}，技能已是 ${rev(row.rev)}，合并有冲突：${result.conflicts.join("、")}；手工合并后写回`,
          "conflict",
          undefined,
          `atrium skill proposal ${proposalRef(p.id)}`,
        );
      files = result.files;
      merged = true;
    }
    const meta = skillMeta(row.slug, validateFiles(files));
    if (sameFiles(meta.files, filesOf(row)))
      throw new Problem(
        409,
        `${proposalRef(p.id)} 的改动已在当前版里，直接驳回即可`,
        "conflict",
        undefined,
        `atrium skill reject ${proposalRef(p.id)} --reason 已包含`,
      );
    const next = commit(
      db,
      row,
      { files: meta.files, description: meta.description },
      taskRef(p.task_id),
      reason,
      proposalRef(p.id),
      actor,
    );
    decide(db, p, "accepted", actor, reason, next.rev);
    return {
      ref: proposalRef(p.id),
      slug: row.slug,
      before: rev(row.rev),
      rev: rev(next.rev),
      merged,
    };
  });
}

export function rejectProposal(
  db: DatabaseSync,
  value: string,
  reasonText: unknown,
  actor: string,
) {
  return transaction(db, () => {
    const p = proposalById(db, value);
    if (p.status !== "pending")
      throw new Problem(
        409,
        `${proposalRef(p.id)} 已${p.status === "accepted" ? "采纳" : "驳回"}`,
        "conflict",
      );
    const row = one<SkillRow>(
      db,
      "SELECT * FROM org_skills WHERE id=?",
      p.skill_id,
    )!;
    authorize(nodes(db), row.owner_node_id, actor, "审核技能提议");
    const reason = validateReason(reasonText);
    decide(db, p, "rejected", actor, reason, null);
    return { ref: proposalRef(p.id), slug: row.slug, status: "rejected" };
  });
}

/** 收尾时记一条提议；同一任务对同一技能已有相同内容的提议就不重复记。 */
export function recordProposal(
  db: DatabaseSync,
  input: {
    skillId: number;
    taskId: number;
    baseRev: number;
    files: Files;
    reason: string;
  },
): { id: number; created: boolean } {
  return transaction(db, () => {
    const text = JSON.stringify(input.files);
    const existing = one<{ id: number }>(
      db,
      "SELECT id FROM org_skill_proposals WHERE task_id=? AND skill_id=? AND files=? LIMIT 1",
      input.taskId,
      input.skillId,
      text,
    );
    if (existing) return { id: existing.id, created: false };
    const id = Number(
      db
        .prepare(
          "INSERT INTO org_skill_proposals(skill_id,task_id,base_rev,files,reason,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          input.skillId,
          input.taskId,
          input.baseRev,
          text,
          Array.from(input.reason).slice(0, LIMITS.proposalReason).join(""),
          Date.now(),
        ).lastInsertRowid,
    );
    return { id, created: true };
  });
}

/** 某个修订的完整文件（挂载时记下的基准版本）。 */
export function filesAt(
  db: DatabaseSync,
  skillId: number,
  at: number,
): Files | undefined {
  const found = one<{ snapshot: string }>(
    db,
    "SELECT snapshot FROM org_skill_revisions WHERE skill_id=? AND rev=?",
    skillId,
    at,
  );
  return found ? (JSON.parse(found.snapshot) as Snapshot).files : undefined;
}

export type Owner = { node: string | null; leader: string | null };

/** 技能 owner 节点及其 leader（没有 leader 就往上找），提议事件带上它。 */
export function ownerOf(db: DatabaseSync, skillId: number): Owner {
  const row = one<SkillRow>(db, "SELECT * FROM org_skills WHERE id=?", skillId);
  if (!row || row.owner_node_id === null) return { node: null, leader: "u1" };
  const list = nodes(db);
  let current = list.find((n) => n.id === row.owner_node_id);
  const node = ownerLabel(list, row.owner_node_id);
  while (current) {
    if (current.leader) return { node, leader: current.leader };
    const parent: number | null = current.parent_id;
    current = list.find((n) => n.id === parent);
  }
  return { node, leader: "u1" };
}
