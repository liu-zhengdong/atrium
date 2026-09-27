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
import { exportBoundaries, type Converted } from "./boundaries.ts";
import {
  ownBoundaries,
  planBoundaries,
  saveBoundaries,
} from "./boundary-store.ts";
import {
  checkStoredShares,
  ownShares,
  planShares,
  saveShares,
} from "./share-store.ts";
import { exportShares } from "./shares.ts";
import { HUMAN_KEYS } from "./overview.ts";

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
  /** "aspect" 建管方面的部分（#373）：按父节点取 project / module，另记 aspect=1。 */
  kind: Kind | "aspect";
  name: string;
  leader?: string | null;
  repos?: string[];
  reason: string;
};
export function addNode(db: DatabaseSync, input: AddInput, actor: string) {
  return transaction(db, () => {
    if ("doc_path" in input)
      throw new Problem(400, "doc_path 已停用，请编辑节点章程正文");
    const list = nodes(db);
    if (list.length >= 500) throw new Problem(400, "组织树已达 500 个节点");
    const parent = input.parent ? nodeByAddress(db, input.parent) : null;
    const aspect = input.kind === "aspect";
    if (aspect && !parent)
      throw new Problem(400, "管方面的部分要挂在某个部分下面");
    const kind = aspect
        ? parent!.kind === "org"
          ? "project"
          : "module"
        : validateKind(input.kind),
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
    } else if (actor !== "u1") throw new Problem(403, "根节点只有你能创建");
    if (list.some((n) => n.parent_id === parent?.id && n.slug === slug))
      throw new Problem(409, `slug ${slug} 在同一父节点下已存在`);
    const leader = input.leader ?? (kind === "org" ? "u1" : null);
    if (leader !== null && !/^(u1|a[1-9][0-9]*)$/.test(leader))
      throw new Problem(400, "leader 应为 u1 或 aN");
    const repos = repoPaths(input.repos ?? []);
    const now = Date.now();
    const result = db
      .prepare(
        "INSERT INTO org_nodes(parent_id,kind,slug,name,leader,aspect,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        parent?.id ?? null,
        kind,
        slug,
        name,
        leader,
        aspect ? 1 : 0,
        now,
        now,
      );
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
  input: {
    fields: unknown;
    body: unknown;
    boundaries?: unknown;
    budget?: unknown;
    rev?: string;
    reason: unknown;
  },
  actor: string,
) {
  return transaction(db, () => {
    const node = nodeByAddress(db, address);
    authorized(db, node, actor, doc);
    if (node.archived_at !== null)
      throw new Problem(400, `${ref(node.id)} 已归档`);
    expectedRev(input.rev, current(db, node.id, doc)?.rev ?? 0, node.id, doc);
    return editDocInner(
      db,
      node,
      doc,
      input,
      validateReason(input.reason),
      actor,
    );
  });
}
/**
 * 只改章程里的阶段记录（stages），其余字段、正文、边界与预算原样保留；留章程修订。
 * leader 改本节点的阶段走这里，不经整份章程（那会连带边界与预算）。
 */
export function editStages(
  db: DatabaseSync,
  address: string,
  stages: unknown,
  reason: unknown,
  actor: string,
) {
  return transaction(db, () => {
    const node = nodeByAddress(db, address);
    authorized(db, node, actor, "charter");
    if (node.archived_at !== null)
      throw new Problem(400, `${ref(node.id)} 已归档`);
    const old = current(db, node.id, "charter");
    const fields = old
      ? (JSON.parse(old.fields) as Record<string, unknown>)
      : {};
    return editDocInner(
      db,
      node,
      "charter",
      { fields: { ...fields, stages }, body: old?.body ?? "" },
      validateReason(reason),
      actor,
    );
  });
}
/** 全景人话字段只改当前章程；正文若同时修改，仍单独留章程修订。 */
export function editOverviewFields(
  db: DatabaseSync,
  address: string,
  fields: Record<string, unknown>,
  actor: string,
  detail?: { body: unknown; rev?: string; reason: unknown },
) {
  return transaction(db, () => {
    const node = nodeByAddress(db, address);
    authorized(db, node, actor, "charter");
    if (node.archived_at !== null)
      throw new Problem(400, `${ref(node.id)} 已归档`);
    const old = current(db, node.id, "charter");
    const validated = validateFields("charter", fields);
    const previousFields = old
      ? (JSON.parse(old.fields) as Record<string, unknown>)
      : {};
    for (const key of new Set([
      ...Object.keys(previousFields),
      ...Object.keys(validated),
    ]))
      if (
        !HUMAN_KEYS.has(key) &&
        JSON.stringify(previousFields[key]) !== JSON.stringify(validated[key])
      )
        throw new Problem(400, `${key} 应走章程修订`);
    let revisionResult: ReturnType<typeof editDocInner> | undefined;
    if (detail) {
      expectedRev(detail.rev, old?.rev ?? 0, node.id, "charter");
      revisionResult = editDocInner(
        db,
        node,
        "charter",
        { fields: previousFields, body: detail.body },
        validateReason(detail.reason),
        actor,
      );
    }
    if (JSON.stringify(validated) !== (old?.fields ?? "{}")) {
      const previous = current(db, node.id, "charter");
      const at = Math.max(Date.now(), (previous?.updated_at ?? 0) + 1);
      db.prepare(
        "INSERT INTO org_docs(node_id,doc,rev,fields,body,updated_by,updated_at) VALUES(?,'charter',0,?,'',?,?) ON CONFLICT(node_id,doc) DO UPDATE SET fields=excluded.fields,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
      ).run(node.id, JSON.stringify(validated), actor, at);
    }
    return {
      node: ref(node.id),
      ...(revisionResult
        ? { before: revisionResult.before, rev: revisionResult.rev }
        : {}),
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
      boundaries?: unknown;
      budget?: unknown;
    };
    // 第 2 步之前的章程修订没有 boundaries：当时本节点没有边界
    if (doc === "charter") {
      snapshot.boundaries ??= [];
      snapshot.budget ??= {};
      const latest = current(db, node.id, "charter");
      const fields = snapshot.fields as Record<string, unknown>;
      const currentFields = latest
        ? (JSON.parse(latest.fields) as Record<string, unknown>)
        : {};
      for (const key of HUMAN_KEYS) {
        if (Object.hasOwn(currentFields, key)) fields[key] = currentFields[key];
        else delete fields[key];
      }
    }
    return editDocInner(db, node, doc, snapshot, validateReason(reason), actor);
  });
}
function writeDoc(
  db: DatabaseSync,
  node: number,
  doc: Doc,
  fields: Record<string, unknown>,
  body: string,
  reason: string,
  actor: string,
) {
  const next = (current(db, node, doc)?.rev ?? 0) + 1;
  db.prepare(
    "INSERT INTO org_docs(node_id,doc,rev,fields,body,updated_by,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(node_id,doc) DO UPDATE SET rev=excluded.rev,fields=excluded.fields,body=excluded.body,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
  ).run(node, doc, next, JSON.stringify(fields), body, actor, Date.now());
  revision(db, node, doc, next, actor, reason, {
    fields:
      doc === "charter"
        ? Object.fromEntries(
            Object.entries(fields).filter(([key]) => !HUMAN_KEYS.has(key)),
          )
        : fields,
    body,
    ...(doc === "charter"
      ? {
          boundaries: exportBoundaries(ownBoundaries(db, node)),
          budget: exportShares(ownShares(db, node)),
        }
      : {}),
  });
  return next;
}
/** 上层删除或移走条目后，后代的覆盖条目转为自有条目：补上文字并给后代章程追加修订。 */
function applyConverted(
  db: DatabaseSync,
  from: NodeRow,
  converted: Converted[],
  reason: string,
  actor: string,
) {
  const touched = [...new Set(converted.map((c) => c.node))];
  const update = db.prepare(
    "UPDATE org_boundaries SET summary=? WHERE node_id=? AND bid=?",
  );
  for (const c of converted) update.run(c.summary, c.node, c.id);
  for (const id of touched) {
    const old = current(db, id, "charter");
    writeDoc(
      db,
      id,
      "charter",
      old ? (JSON.parse(old.fields) as Record<string, unknown>) : {},
      old?.body ?? "",
      `因 ${ref(from.id)} ${from.name} 的修改，${converted
        .filter((c) => c.node === id)
        .map((c) => c.id)
        .join("、")} 转为本节点自有条目：${reason}`,
      actor,
    );
  }
  return converted.map((c) => ({ node: ref(c.node), id: c.id }));
}
function editDocInner(
  db: DatabaseSync,
  node: NodeRow,
  doc: Doc,
  snapshot: {
    fields: unknown;
    body: unknown;
    boundaries?: unknown;
    budget?: unknown;
  },
  reason: string,
  actor: string,
) {
  const before = current(db, node.id, doc)?.rev ?? 0;
  const fields = validateFields(doc, snapshot.fields),
    body = validateBody(snapshot.body);
  let converted: Converted[] = [];
  if (doc === "card") {
    if (snapshot.boundaries !== undefined)
      throw new Problem(400, "card.boundaries 是未知字段，边界写在章程里");
    if (snapshot.budget !== undefined)
      throw new Problem(400, "card.budget 是未知字段，份额写在章程里");
  } else if (snapshot.boundaries !== undefined) {
    const plan = planBoundaries(db, nodes(db), node, snapshot.boundaries);
    saveBoundaries(db, node.id, plan.entries);
    converted = plan.converted;
  }
  if (doc === "charter" && snapshot.budget !== undefined)
    saveShares(db, node.id, planShares(db, node, snapshot.budget));
  // 根保留或花费边界变严时，已有下级份额也必须满足新上限。
  if (doc === "charter" && snapshot.boundaries !== undefined)
    checkStoredShares(db, node);
  const next = writeDoc(db, node.id, doc, fields, body, reason, actor);
  return {
    node: ref(node.id),
    doc,
    before: `r${before}`,
    rev: `r${next}`,
    fields,
    body,
    ...(doc === "charter"
      ? {
          boundaries: exportBoundaries(ownBoundaries(db, node.id)),
          budget: exportShares(ownShares(db, node.id)),
          converted: applyConverted(db, node, converted, reason, actor),
        }
      : {}),
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
    repos?: string[];
    archive?: boolean;
    rev?: string;
    reason: unknown;
  },
  actor: string,
) {
  return transaction(db, () => {
    if ("doc_path" in input)
      throw new Problem(400, "doc_path 已停用，请编辑节点章程正文");
    const node = nodeByAddress(db, address);
    authorized(db, node, actor, "node");
    if (node.parent_id === null && actor !== "u1")
      throw new Problem(403, "根节点只有你能改");
    const old = one<{ rev: number }>(
      db,
      "SELECT rev FROM org_revisions WHERE node_id=? AND target='node' ORDER BY rev DESC LIMIT 1",
      node.id,
    )!.rev;
    expectedRev(input.rev, old, node.id, "node");
    const reason = validateReason(input.reason);
    let parent = node.parent_id;
    let moved: Converted[] = [];
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
      if (target.id !== node.parent_id)
        moved = planBoundaries(db, list, node, undefined, {
          newParent: target.id,
          what: "位置",
        }).converted;
      if (target.id !== node.parent_id) checkStoredShares(db, node, target.id);
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
    const converted = applyConverted(db, node, moved, reason, actor);
    return {
      ...nodeSnapshot(db, node.id),
      rev: `r${old + 1}`,
      ...(converted.length ? { converted } : {}),
    };
  });
}
export type ImportInput = {
  charter: { fields: unknown; body: unknown };
  repo: string;
  atrium_goal?: string;
  openquota_goal?: string;
  docs: {
    kind: "module";
    slug: string;
    name: string;
    source: string;
    body: string;
  }[];
  apply: boolean;
};
export function importOrg(db: DatabaseSync, input: ImportInput, actor: string) {
  if (actor !== "u1") throw new Problem(403, "org import 只有你能执行");
  const fields = validateFields("charter", input.charter?.fields),
    body = validateBody(input.charter?.body);
  repoPaths([input.repo]);
  if (!Array.isArray(input.docs) || input.docs.length > 200)
    throw new Problem(400, "docs 超过 200 项");
  const seen = new Set<string>();
  for (const doc of input.docs) {
    validateSlug(doc.slug);
    if (
      doc.kind !== "module" ||
      !/^\.agents\/modules\/(?:[a-z0-9-]|[\u3400-\u9fff]){1,40}\.md$/.test(
        doc.source,
      ) ||
      doc.source.includes("..") ||
      !doc.source.startsWith(".agents/modules/")
    )
      throw new Problem(400, "docs 格式错误");
    try {
      validateBody(doc.body);
    } catch {
      throw new Problem(400, `${doc.source} 正文超过 16 KB 或格式错误`);
    }
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
    const changes: string[] = [];
    let root = nodes(db).find((n) => n.parent_id === null);
    if (!root) {
      const id = addNodeInnerRoot(db, actor);
      changes.push(`新建 ${ref(id)} 组织`);
      root = nodes(db).find((n) => n.parent_id === null)!;
    }
    if (!current(db, root.id, "charter")) {
      const edit = editDocInner(
        db,
        root,
        "charter",
        { fields, body },
        "导入根章程",
        actor,
      );
      changes.push(`更新 ${ref(root.id)} 组织章程 ${edit.rev}`);
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
          repos,
          "组织树初始化",
        );
        changes.push(`新建 ${ref(id)} ${name}`);
        found = one<NodeRow>(db, "SELECT * FROM org_nodes WHERE id=?", id)!;
      }
      if (!current(db, found.id, "charter")) {
        const edit = editDocInner(
          db,
          found,
          "charter",
          { fields: { goal }, body: "" },
          "导入项目目标",
          actor,
        );
        changes.push(`更新 ${ref(found.id)} ${name} 章程 ${edit.rev}`);
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
    for (const doc of input.docs) {
      let found = nodes(db).find(
        (n) => n.parent_id === atrium.id && n.slug === doc.slug,
      );
      if (!found) {
        const id = insertNode(
          db,
          atrium.id,
          doc.kind,
          doc.slug,
          doc.name,
          actor,
          [input.repo],
          "导入岗位说明",
        );
        changes.push(`新建 ${ref(id)} atrium/${doc.slug}`);
        found = one<NodeRow>(db, "SELECT * FROM org_nodes WHERE id=?", id)!;
      }
      if (found.kind !== doc.kind)
        throw new Problem(409, `atrium/${doc.slug} 类型不是 ${doc.kind}`);
      const previous = current(db, found.id, "charter");
      if (!previous || previous.body !== doc.body) {
        const edit = editDocInner(
          db,
          found,
          "charter",
          {
            fields: previous ? JSON.parse(previous.fields) : {},
            body: doc.body,
          },
          "从 .agents 导入",
          actor,
        );
        changes.push(
          `更新 ${ref(found.id)} atrium/${doc.slug} 章程 ${edit.rev}`,
        );
      }
    }
    return { preview: false, plan: changes, created: changes.length };
  });
}
function insertNode(
  db: DatabaseSync,
  parent: number | null,
  kind: Kind,
  slug: string,
  name: string,
  actor: string,
  repos: string[],
  reason: string,
) {
  if (nodes(db).length >= 500) throw new Problem(400, "组织树已达 500 个节点");
  const now = Date.now();
  const id = Number(
    db
      .prepare(
        "INSERT INTO org_nodes(parent_id,kind,slug,name,leader,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(parent, kind, slug, name, kind === "org" ? "u1" : null, now, now)
      .lastInsertRowid,
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
  return insertNode(db, null, "org", "org", "组织", actor, [], "组织树初始化");
}
/** 读本节点章程字段；没有章程为空对象。 */
export function charterFields(
  db: DatabaseSync,
  node: number,
): Record<string, unknown> {
  const old = current(db, node, "charter");
  return old ? (JSON.parse(old.fields) as Record<string, unknown>) : {};
}
/**
 * 只换章程字段，正文、边界与份额不动（目标树迁移用）；留一条章程修订。
 * 调用方负责事务与权限。
 */
export function writeCharterFields(
  db: DatabaseSync,
  node: number,
  fields: Record<string, unknown>,
  reason: string,
  actor: string,
) {
  const row = one<NodeRow>(db, "SELECT * FROM org_nodes WHERE id=?", node);
  if (!row) throw new Problem(404, `${ref(node)} 不存在`);
  return editDocInner(
    db,
    row,
    "charter",
    { fields, body: current(db, node, "charter")?.body ?? "" },
    validateReason(reason),
    actor,
  );
}
