import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  all,
  canEdit,
  nodeByAddress,
  nodes,
  one,
  ref,
  transaction,
  type Doc,
  type DocRow,
  type Kind,
  type NodeRow,
  type RevisionRow,
} from "./model.ts";
import {
  validateBody,
  validateFields,
  validateKind,
  validateReason,
  validateSlug,
  validParent,
} from "./validate.ts";

function authorized(
  db: DatabaseSync,
  node: NodeRow,
  actor: string,
  target: string,
) {
  if (
    (node.parent_id === null && target === "charter" && actor !== "u1") ||
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
  const repos = all<{ repo: string }>(
    db,
    "SELECT repo FROM org_node_repos WHERE node_id=? ORDER BY repo",
    id,
  ).map((r) => r.repo);
  return { ...node, repos };
}
function docPath(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (
    !/^\.agents\/(modules|concerns)\/(?:[a-z0-9-]|[\u3400-\u9fff]){1,40}\.md$/.test(
      value,
    ) ||
    value.includes("..")
  )
    throw new Problem(
      400,
      "doc_path 应为 .agents/modules 或 .agents/concerns 下的 Markdown 文件",
    );
  return value;
}
function repoPaths(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (repo) =>
        typeof repo !== "string" ||
        !repo.startsWith("/") ||
        repo.split("/").includes(".."),
    )
  )
    throw new Problem(400, "repos 应为绝对路径列表，不能包含 ..");
  return [...new Set(value as string[])];
}
export type AddInput = {
  parent?: string;
  slug: string;
  kind: Kind;
  name: string;
  leader?: string | null;
  doc_path?: string | null;
  repos?: string[];
  reason: string;
};
export function addNode(db: DatabaseSync, input: AddInput, actor: string) {
  return transaction(db, () => {
    const list = nodes(db);
    if (list.length >= 500) throw new Problem(400, "组织树已达 500 个节点");
    const kind = validateKind(input.kind),
      slug = validateSlug(input.slug),
      reason = validateReason(input.reason);
    const name = input.name?.trim();
    if (!name || Array.from(name).length > 100)
      throw new Problem(400, "name 应为 1–100 字");
    const parent = input.parent ? nodeByAddress(db, input.parent) : null;
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
    } else if (actor !== "u1") throw new Problem(403, "根节点只有 u1 能创建");
    if (list.some((n) => n.parent_id === parent?.id && n.slug === slug))
      throw new Problem(409, `slug ${slug} 在同一父节点下已存在`);
    const leader = input.leader ?? (kind === "org" ? "u1" : null);
    if (leader !== null && !/^(u1|a[1-9][0-9]*)$/.test(leader))
      throw new Problem(400, "leader 应为 u1 或 aN");
    const document = docPath(input.doc_path);
    const repos = repoPaths(input.repos ?? []);
    const now = Date.now();
    const result = db
      .prepare(
        "INSERT INTO org_nodes(parent_id,kind,slug,name,leader,doc_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(parent?.id ?? null, kind, slug, name, leader, document, now, now);
    const id = Number(result.lastInsertRowid);
    for (const repo of repos)
      db.prepare("INSERT INTO org_node_repos(node_id,repo) VALUES(?,?)").run(
        id,
        repo,
      );
    revision(db, id, "node", 1, actor, reason, nodeSnapshot(db, id));
    return nodeSnapshot(db, id);
  });
}
function current(db: DatabaseSync, id: number, doc: Doc): DocRow | undefined {
  return one<DocRow>(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc=?",
    id,
    doc,
  );
}
function expectedRev(value: unknown, actual: number, id: number, doc: string) {
  if (value === undefined) return;
  if (typeof value !== "string" || !/^r(0|[1-9][0-9]*)$/.test(value))
    throw new Problem(400, "--rev 应为 rN");
  if (Number(value.slice(1)) !== actual)
    throw new Problem(
      409,
      `${doc} 已是 r${actual}，你基于 ${value} 修改；先看变化：atrium org history ${ref(id)} --after ${value}`,
      "conflict",
      undefined,
      `atrium org history ${ref(id)}`,
    );
}
export function editDoc(
  db: DatabaseSync,
  address: string,
  doc: Doc,
  input: { fields: unknown; body: unknown; rev?: string; reason: unknown },
  actor: string,
) {
  return transaction(db, () => {
    const node = nodeByAddress(db, address);
    authorized(db, node, actor, doc);
    if (node.archived_at !== null)
      throw new Problem(400, `${ref(node.id)} 已归档`);
    const old = current(db, node.id, doc),
      before = old?.rev ?? 0;
    expectedRev(input.rev, before, node.id, doc);
    const fields = validateFields(doc, input.fields),
      body = validateBody(input.body),
      reason = validateReason(input.reason);
    const now = Date.now(),
      next = before + 1;
    db.prepare(
      "INSERT INTO org_docs(node_id,doc,rev,fields,body,updated_by,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(node_id,doc) DO UPDATE SET rev=excluded.rev,fields=excluded.fields,body=excluded.body,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
    ).run(node.id, doc, next, JSON.stringify(fields), body, actor, now);
    revision(db, node.id, doc, next, actor, reason, { fields, body });
    return {
      node: ref(node.id),
      doc,
      before: `r${before}`,
      rev: `r${next}`,
      fields,
      body,
    };
  });
}
export function revertDoc(
  db: DatabaseSync,
  address: string,
  doc: Doc,
  to: string,
  reason: string,
  actor: string,
) {
  return transaction(db, () => {
    const node = nodeByAddress(db, address);
    authorized(db, node, actor, doc);
    if (!/^r[1-9][0-9]*$/.test(to)) throw new Problem(400, "--to 应为 rN");
    const found = one<RevisionRow>(
      db,
      "SELECT * FROM org_revisions WHERE node_id=? AND target=? AND rev=?",
      node.id,
      doc,
      Number(to.slice(1)),
    );
    if (!found) throw new Problem(404, `${doc} ${to} 不存在`);
    const snapshot = JSON.parse(found.snapshot) as {
      fields: unknown;
      body: unknown;
    };
    return editDocInner(db, node, doc, snapshot, validateReason(reason), actor);
  });
}
function editDocInner(
  db: DatabaseSync,
  node: NodeRow,
  doc: Doc,
  snapshot: { fields: unknown; body: unknown },
  reason: string,
  actor: string,
) {
  const old = current(db, node.id, doc),
    next = (old?.rev ?? 0) + 1;
  const fields = validateFields(doc, snapshot.fields),
    body = validateBody(snapshot.body),
    now = Date.now();
  db.prepare(
    "INSERT INTO org_docs(node_id,doc,rev,fields,body,updated_by,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(node_id,doc) DO UPDATE SET rev=excluded.rev,fields=excluded.fields,body=excluded.body,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
  ).run(node.id, doc, next, JSON.stringify(fields), body, actor, now);
  revision(db, node.id, doc, next, actor, reason, { fields, body });
  return {
    node: ref(node.id),
    doc,
    before: `r${next - 1}`,
    rev: `r${next}`,
    fields,
    body,
  };
}
export function editNode(
  db: DatabaseSync,
  address: string,
  input: {
    slug?: string;
    name?: string;
    leader?: string | null;
    parent?: string;
    doc_path?: string | null;
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
    if (node.parent_id === null && actor !== "u1")
      throw new Problem(403, "根节点只有 u1 能改");
    const old = one<{ rev: number }>(
      db,
      "SELECT rev FROM org_revisions WHERE node_id=? AND target='node' ORDER BY rev DESC LIMIT 1",
      node.id,
    )!.rev;
    expectedRev(input.rev, old, node.id, "node");
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
    const document =
      input.doc_path === undefined ? node.doc_path : docPath(input.doc_path);
    const repos =
      input.repos === undefined ? undefined : repoPaths(input.repos);
    const archived = input.archive === true ? Date.now() : node.archived_at;
    db.prepare(
      "UPDATE org_nodes SET parent_id=?,slug=?,name=?,leader=?,doc_path=?,archived_at=?,updated_at=? WHERE id=?",
    ).run(parent, slug, name, leader, document, archived, Date.now(), node.id);
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
export type ImportInput = {
  charter: { fields: unknown; body: unknown };
  repo: string;
  atrium_goal?: string;
  openquota_goal?: string;
  docs: {
    kind: "module" | "concern";
    slug: string;
    name: string;
    doc_path: string;
  }[];
  apply: boolean;
};
export function importOrg(db: DatabaseSync, input: ImportInput, actor: string) {
  if (actor !== "u1") throw new Problem(403, "org import 只有 u1 能执行");
  const fields = validateFields("charter", input.charter?.fields),
    body = validateBody(input.charter?.body);
  repoPaths([input.repo]);
  if (!Array.isArray(input.docs) || input.docs.length > 200)
    throw new Problem(400, "docs 超过 200 项");
  const seen = new Set<string>();
  for (const doc of input.docs) {
    validateSlug(doc.slug);
    if (
      !["module", "concern"].includes(doc.kind) ||
      !/^\.agents\/(modules|concerns)\/(?:[a-z0-9-]|[\u3400-\u9fff]){1,40}\.md$/.test(
        doc.doc_path,
      ) ||
      doc.doc_path.includes("..") ||
      !doc.doc_path.startsWith(
        doc.kind === "module" ? ".agents/modules/" : ".agents/concerns/",
      )
    )
      throw new Problem(400, "docs 格式错误");
    if (seen.has(doc.slug)) throw new Problem(400, `docs.${doc.slug} 重复`);
    seen.add(doc.slug);
  }
  const plan = [
    "组织",
    "Atrium 项目",
    "OpenQuota 项目",
    ...input.docs.map((d) => `${d.kind} ${d.name}`),
  ];
  if (!input.apply) return { preview: true, plan };
  return transaction(db, () => {
    let created = 0;
    let root = nodes(db).find((n) => n.parent_id === null);
    if (!root) {
      addNodeInnerRoot(db, actor);
      created++;
      root = nodes(db).find((n) => n.parent_id === null)!;
    }
    if (!current(db, root.id, "charter")) {
      editDocInner(db, root, "charter", { fields, body }, "导入根章程", actor);
      created++;
    }
    const project = (
      slug: string,
      name: string,
      goal: string,
      repos: string[],
    ) => {
      let found = nodes(db).find(
        (n) => n.parent_id === root!.id && n.slug === slug,
      );
      if (!found) {
        const id = insertNode(
          db,
          root!.id,
          "project",
          slug,
          name,
          actor,
          null,
          repos,
          "组织树初始化",
        );
        created++;
        found = one<NodeRow>(db, "SELECT * FROM org_nodes WHERE id=?", id)!;
      }
      if (!current(db, found.id, "charter")) {
        editDocInner(
          db,
          found,
          "charter",
          { fields: { goal }, body: "" },
          "导入项目目标",
          actor,
        );
        created++;
      }
      return found;
    };
    const atrium = project(
      "atrium",
      "Atrium",
      String(input.atrium_goal ?? fields.goal ?? ""),
      [input.repo],
    );
    project(
      "openquota",
      "OpenQuota",
      String(
        input.openquota_goal ??
          "各家订阅额度看得清、查得到，供组织按富余调度。",
      ),
      [],
    );
    for (const doc of input.docs)
      if (
        !nodes(db).some((n) => n.parent_id === atrium.id && n.slug === doc.slug)
      ) {
        insertNode(
          db,
          atrium.id,
          doc.kind,
          doc.slug,
          doc.name,
          actor,
          doc.doc_path,
          [input.repo],
          "导入岗位说明",
        );
        created++;
      }
    return { preview: false, plan, created };
  });
}
function insertNode(
  db: DatabaseSync,
  parent: number | null,
  kind: Kind,
  slug: string,
  name: string,
  actor: string,
  docPath: string | null,
  repos: string[],
  reason: string,
) {
  if (nodes(db).length >= 500) throw new Problem(400, "组织树已达 500 个节点");
  const now = Date.now();
  const id = Number(
    db
      .prepare(
        "INSERT INTO org_nodes(parent_id,kind,slug,name,leader,doc_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        parent,
        kind,
        slug,
        name,
        kind === "org" ? "u1" : null,
        docPath,
        now,
        now,
      ).lastInsertRowid,
  );
  for (const repo of repos)
    db.prepare("INSERT INTO org_node_repos(node_id,repo) VALUES(?,?)").run(
      id,
      repo,
    );
  revision(db, id, "node", 1, actor, reason, nodeSnapshot(db, id));
  return id;
}
function addNodeInnerRoot(db: DatabaseSync, actor: string) {
  insertNode(db, null, "org", "org", "组织", actor, null, [], "组织树初始化");
}
