import type { DatabaseSync } from "node:sqlite";
import { hasParentSegment, isAbsolutePath } from "../platform/plan.ts";
import { Problem } from "../problem.ts";
import {
  all,
  canEdit,
  nodeByAddress,
  nodes,
  one,
  ref,
  transaction,
  type DocRow,
  type Kind,
  type NodeRow,
} from "./model.ts";
import {
  childKind,
  validateFields,
  validateKind,
  validateReason,
  validateSlug,
  validParent,
} from "./validate.ts";
import { actsForUser } from "../../shared/user.ts";

function authorized(
  db: DatabaseSync,
  node: NodeRow,
  actor: string,
  target: string,
) {
  if (
    (node.parent_id === null && target === "fields" && !actsForUser(actor)) ||
    !canEdit(nodes(db), node, actor)
  )
    throw new Problem(
      403,
      `${target} 无权限：${actor} 不是 ${ref(node.id)} 的 leader 或祖先 leader`,
      "conflict",
    );
}
function revision(
  db: DatabaseSync,
  id: number,
  target: string,
  rev: number,
  actor: string,
  reason: string,
  snapshot: unknown,
) {
  db.prepare(
    "INSERT INTO org_revisions(node_id,target,rev,author,at,reason,snapshot) VALUES(?,?,?,?,?,?,?)",
  ).run(id, target, rev, actor, Date.now(), reason, JSON.stringify(snapshot));
}
function nodeSnapshot(db: DatabaseSync, id: number) {
  const node = one<NodeRow>(db, "SELECT * FROM org_nodes WHERE id=?", id)!;
  const { doc_path: _legacyDocPath, ...visible } = node;
  const repos = all<{ repo: string }>(
    db,
    "SELECT repo FROM org_node_repos WHERE node_id=? ORDER BY repo",
    id,
  ).map((r) => r.repo);
  return { ...visible, repos };
}
function repoPaths(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (repo) =>
        typeof repo !== "string" ||
        !isAbsolutePath(process.platform, repo) ||
        hasParentSegment(process.platform, repo),
    )
  )
    throw new Problem(400, "repos 应为绝对路径列表，不能包含 ..");
  return [...new Set(value as string[])];
}
export type AddInput = {
  parent?: string;
  slug: string;
  /** 不写按上级推断（`org add` 的承诺）；建根必须写。 */
  kind?: Kind;
  name: string;
  leader?: string | null;
  repos?: string[];
  /** 建节点时一起写入的人话字段（是什么、人话名与类比……），省得建完再改一遍。 */
  fields?: Record<string, unknown>;
  reason: string;
};
export function addNode(db: DatabaseSync, input: AddInput, actor: string) {
  return transaction(db, () => {
    const list = nodes(db);
    if (list.length >= 500) throw new Problem(400, "组织树已达 500 个节点");
    const parent = input.parent ? nodeByAddress(db, input.parent) : null;
    const inferred = parent ? childKind(parent.kind) : null;
    if (input.kind === undefined && !parent)
      throw new Problem(
        400,
        "kind: 建根时必填，如 atrium org add org --kind org --name 组织 --reason 建树",
        "usage",
      );
    if (input.kind === undefined && !inferred)
      throw new Problem(
        400,
        `${ref(parent!.id)} 是关注点，下面不能再加部门`,
        "usage",
      );
    const kind =
        input.kind === undefined ? inferred! : validateKind(input.kind),
      slug = validateSlug(input.slug),
      reason = validateReason(input.reason);
    const name = input.name?.trim();
    if (!name || Array.from(name).length > 100)
      throw new Problem(400, "name 应为 1–100 字");
    if (!parent && (kind !== "org" || list.length))
      throw new Problem(400, "parent 必须指定合法父节点；org 只能有一个根");
    if (parent) {
      authorized(db, parent, actor, "node");
      if (parent.archived_at !== null) throw new Problem(400, "parent 已归档");
      if (!validParent(parent.kind, kind))
        throw new Problem(400, `kind ${kind} 不能挂在 ${parent.kind} 下`);
      let depth = 1,
        current: NodeRow | undefined = parent;
      while (current) {
        depth++;
        current = list.find((n) => n.id === current?.parent_id);
      }
      if (depth > 8) throw new Problem(400, "parent 层级超过深度 8");
    } else if (!actsForUser(actor))
      throw new Problem(403, "根节点只有你能创建");
    if (list.some((n) => n.parent_id === parent?.id && n.slug === slug))
      throw new Problem(409, `slug ${slug} 在同一父节点下已存在`);
    const leader = input.leader ?? (kind === "org" ? "u1" : null);
    if (leader !== null && !/^(u1|a[1-9][0-9]*)$/.test(leader))
      throw new Problem(400, "leader 应为 u1 或 aN");
    const repos = repoPaths(input.repos ?? []);
    const now = Date.now();
    const result = db
      .prepare(
        "INSERT INTO org_nodes(parent_id,kind,slug,name,leader,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(parent?.id ?? null, kind, slug, name, leader, now, now);
    const id = Number(result.lastInsertRowid);
    for (const repo of repos)
      db.prepare("INSERT INTO org_node_repos(node_id,repo) VALUES(?,?)").run(
        id,
        repo,
      );
    revision(db, id, "node", 1, actor, reason, nodeSnapshot(db, id));
    if (input.fields && Object.keys(input.fields).length)
      writeFields(db, id, validateFields(input.fields), actor, now);
    return nodeSnapshot(db, id);
  });
}
/** 读本部门的人话字段（是什么、怎么用、现状、阶段……）；没写为空对象，坏数据当没写。 */
export function nodeFields(
  db: DatabaseSync,
  node: number,
): Record<string, unknown> {
  const row = one<Pick<DocRow, "fields">>(
    db,
    "SELECT fields FROM org_docs WHERE node_id=? AND doc='charter'",
    node,
  );
  try {
    const fields = row ? (JSON.parse(row.fields) as unknown) : {};
    return fields && typeof fields === "object" && !Array.isArray(fields)
      ? (fields as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 写人话字段（当前值，不留修订）：建节点与改字段共用同一份 upsert。 */
function writeFields(
  db: DatabaseSync,
  id: number,
  fields: Record<string, unknown>,
  actor: string,
  at: number,
) {
  db.prepare(
    "INSERT INTO org_docs(node_id,doc,rev,fields,body,updated_by,updated_at) VALUES(?,'charter',0,?,'',?,?) ON CONFLICT(node_id,doc) DO UPDATE SET fields=excluded.fields,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
  ).run(id, JSON.stringify(fields), actor, at);
}
/** 改人话字段：整份覆盖当前值，不留修订（全景图只要当前版本）。根只有用户能改，其余按 leader 链。 */
export function editFields(
  db: DatabaseSync,
  address: string,
  fields: Record<string, unknown>,
  actor: string,
) {
  return transaction(db, () => {
    const node = nodeByAddress(db, address);
    authorized(db, node, actor, "fields");
    if (node.archived_at !== null)
      throw new Problem(400, `${ref(node.id)} 已归档`);
    writeFields(db, node.id, validateFields(fields), actor, Date.now());
    return { node: ref(node.id) };
  });
}
export function editNode(
  db: DatabaseSync,
  address: string,
  input: {
    slug?: string;
    name?: string;
    leader?: string | null;
    parent?: string;
    repos?: string[];
    archive?: boolean;
    rev?: string;
    reason: unknown;
  },
  actor: string,
) {
  return transaction(db, () => {
    const node = nodeByAddress(db, address);
    authorized(db, node, actor, "node");
    if (node.parent_id === null && !actsForUser(actor))
      throw new Problem(403, "根节点只有你能改");
    const old = one<{ rev: number }>(
      db,
      "SELECT rev FROM org_revisions WHERE node_id=? AND target='node' ORDER BY rev DESC LIMIT 1",
      node.id,
    )!.rev;
    if (input.rev !== undefined && input.rev !== `r${old}`)
      throw new Problem(
        409,
        `节点已是 r${old}，你基于 ${String(input.rev)} 修改；先看变化：atrium org show ${ref(node.id)} --history`,
        "conflict",
        undefined,
        `atrium org show ${ref(node.id)} --history`,
      );
    const reason = validateReason(input.reason);
    let parent = node.parent_id;
    if (input.parent !== undefined) {
      const target = nodeByAddress(db, input.parent);
      authorized(db, target, actor, "node");
      if (target.archived_at !== null) throw new Problem(400, "parent 已归档");
      if (!validParent(target.kind, node.kind))
        throw new Problem(400, "parent 层级不合法");
      let current: NodeRow | undefined = target,
        depth = 1;
      const list = nodes(db);
      while (current) {
        if (current.id === node.id)
          throw new Problem(400, "parent 不能是自身或后代");
        depth++;
        current = list.find((n) => n.id === current?.parent_id);
      }
      const height = (id: number): number =>
        1 +
        Math.max(
          0,
          ...list.filter((n) => n.parent_id === id).map((n) => height(n.id)),
        );
      if (depth + height(node.id) - 1 > 8)
        throw new Problem(400, "parent 层级超过深度 8");
      parent = target.id;
    }
    const slug =
      input.slug === undefined ? node.slug : validateSlug(input.slug);
    if (
      nodes(db).some(
        (n) => n.id !== node.id && n.parent_id === parent && n.slug === slug,
      )
    )
      throw new Problem(409, "slug 在目标父节点下已存在");
    const name = input.name === undefined ? node.name : input.name.trim();
    if (!name || Array.from(name).length > 100)
      throw new Problem(400, "name 应为 1–100 字");
    const leader = input.leader === undefined ? node.leader : input.leader;
    if (leader !== null && !/^(u1|a[1-9][0-9]*)$/.test(leader))
      throw new Problem(400, "leader 应为 u1 或 aN");
    const repos =
      input.repos === undefined ? undefined : repoPaths(input.repos);
    const archived = input.archive === true ? Date.now() : node.archived_at;
    db.prepare(
      "UPDATE org_nodes SET parent_id=?,slug=?,name=?,leader=?,archived_at=?,updated_at=? WHERE id=?",
    ).run(parent, slug, name, leader, archived, Date.now(), node.id);
    if (repos !== undefined) {
      db.prepare("DELETE FROM org_node_repos WHERE node_id=?").run(node.id);
      for (const repo of repos)
        db.prepare("INSERT INTO org_node_repos(node_id,repo) VALUES(?,?)").run(
          node.id,
          repo,
        );
    }
    revision(
      db,
      node.id,
      "node",
      old + 1,
      actor,
      reason,
      nodeSnapshot(db, node.id),
    );
    return { ...nodeSnapshot(db, node.id), rev: `r${old + 1}` };
  });
}
