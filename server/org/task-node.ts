import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  all,
  nodeByAddress,
  nodePath,
  nodes,
  one,
  ref,
  type DocRow,
  type NodeRow,
} from "./model.ts";

/**
 * 任务与组织节点的对应（#264 第 3 步）。role 有三种写法：
 * - 节点：`o4`、`atrium/runtime`，解析不到就报错（写明了要挂节点）；
 * - 旧 `.agents` 名：`runtime`、`modules/runtime`、`concerns/安全`，按任务仓库找挂了该仓库的同名模块／关注点；
 * - 其余带 `/` 的写法先当节点路径，找不到再当旧 `.agents` 相对路径，不报错。
 */

export type RoleMatch =
  { node: NodeRow; path: string } | { node: null; reason: string };

const LEGACY = /^(?:(modules|concerns)\/)?([^/]+?)(?:\.md)?$/;

/** 服务启动时两张表都会建；单测或旧库里没有组织表时视为没有节点。 */
export function hasOrg(db: DatabaseSync): boolean {
  return !!one(
    db,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_nodes'",
  );
}

const trimRepo = (repo: string) =>
  repo.length > 1 ? repo.replace(/\/+$/, "") : repo;

/** 节点自己或任一祖先挂了这个仓库。 */
function coversRepo(
  list: NodeRow[],
  repos: Map<number, string[]>,
  node: NodeRow,
  repo: string,
): boolean {
  let current: NodeRow | undefined = node;
  while (current) {
    if (repos.get(current.id)?.includes(repo)) return true;
    const parent: number | null = current.parent_id;
    current = list.find((n) => n.id === parent);
  }
  return false;
}

function repoMap(db: DatabaseSync): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const row of all<{ node_id: number; repo: string }>(
    db,
    "SELECT node_id,repo FROM org_node_repos ORDER BY node_id LIMIT 5000",
  ))
    map.set(row.node_id, [...(map.get(row.node_id) ?? []), trimRepo(row.repo)]);
  return map;
}

/** 旧 role 名：同名（slug）的模块／关注点里，挂了任务仓库的那一个。 */
export function matchLegacyRole(
  list: NodeRow[],
  repos: Map<number, string[]>,
  role: string,
  repo: string | null,
): RoleMatch {
  const legacy = LEGACY.exec(role.trim());
  if (!legacy) return { node: null, reason: "不是旧岗位名" };
  const kind =
    legacy[1] === "modules"
      ? "module"
      : legacy[1] === "concerns"
        ? "concern"
        : undefined;
  const named = list.filter(
    (n) =>
      n.archived_at === null &&
      n.slug === legacy[2] &&
      (kind ? n.kind === kind : n.kind === "module" || n.kind === "concern"),
  );
  if (!named.length) return { node: null, reason: "没有同名节点" };
  const found = repo
    ? named.filter((n) => coversRepo(list, repos, n, trimRepo(repo)))
    : named;
  if (found.length === 1)
    return { node: found[0]!, path: nodePath(list, found[0]!) };
  if (!found.length)
    return {
      node: null,
      reason: `同名节点 ${named.map((n) => ref(n.id)).join("、")} 都没有挂任务仓库`,
    };
  return {
    node: null,
    reason: `多个同名节点：${found.map((n) => ref(n.id)).join("、")}`,
  };
}

/**
 * 解析任务 role 对应的节点。explicit=true 用于建任务／改任务：写成节点地址却解析不到时报错；
 * 派活与迁移时只查不报错。批量时用 roleMatcher 复用一次读出的节点与仓库。
 */
export function matchRole(
  db: DatabaseSync,
  role: string,
  repo: string | null,
  explicit = false,
): RoleMatch {
  return roleMatcher(db)(role, repo, explicit);
}

export function roleMatcher(db: DatabaseSync) {
  if (!hasOrg(db))
    return (
      _role: string,
      _repo: string | null,
      _explicit = false,
    ): RoleMatch => ({
      node: null,
      reason: "还没有组织树",
    });
  const list = nodes(db);
  let repos: Map<number, string[]> | undefined;
  return (role: string, repo: string | null, explicit = false): RoleMatch => {
    const text = role.trim();
    const legacy = /^(?:modules|concerns)\//.test(text) || !text.includes("/");
    if (!legacy || /^o[1-9][0-9]*$/.test(text)) {
      try {
        const node = nodeByAddress(db, text);
        if (node.archived_at !== null) {
          if (explicit)
            throw new Problem(
              400,
              `role: 节点 ${ref(node.id)} ${node.name} 已归档`,
              "usage",
              undefined,
              "atrium org tree",
            );
          return { node: null, reason: `${ref(node.id)} 已归档` };
        }
        return { node, path: nodePath(list, node) };
      } catch (error) {
        if (!(error instanceof Problem)) throw error;
        if (error.message.startsWith("role:")) throw error;
        if (explicit && (error.statusCode !== 404 || /^o\d/.test(text)))
          throw new Problem(
            400,
            `role: ${error.message}`,
            "usage",
            undefined,
            "atrium org tree",
          );
        if (/^o\d/.test(text)) return { node: null, reason: error.message };
        return { node: null, reason: "没有这个节点路径" };
      }
    }
    repos ??= repoMap(db);
    return matchLegacyRole(list, repos, text, repo);
  };
}

/** `--from`：投任务的节点，必须是存在且未归档的节点。 */
export function originNode(db: DatabaseSync, address: string): NodeRow {
  if (!hasOrg(db))
    throw new Problem(
      400,
      "from: 还没有组织树",
      "usage",
      undefined,
      "atrium org import",
    );
  let node: NodeRow;
  try {
    node = nodeByAddress(db, address.trim());
  } catch (error) {
    if (error instanceof Problem)
      throw new Problem(
        400,
        `from: ${error.message}`,
        "usage",
        undefined,
        "atrium org tree",
      );
    throw error;
  }
  if (node.archived_at !== null)
    throw new Problem(
      400,
      `from: 节点 ${ref(node.id)} ${node.name} 已归档`,
      "usage",
    );
  return node;
}

export type NodeDoc = { id: number; ref: string; name: string; body: string };

export function nodeDoc(db: DatabaseSync, id: number): NodeDoc | undefined {
  if (!hasOrg(db)) return undefined;
  const node = one<NodeRow>(db, "SELECT * FROM org_nodes WHERE id=?", id);
  if (!node) return undefined;
  const charter = one<DocRow>(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
    id,
  );
  return { id, ref: ref(id), name: node.name, body: charter?.body ?? "" };
}

/** 派活用：已关联的取 node_id；还没关联的旧 role 按仓库现查（不写回，写回走 org link-roles）。 */
export function taskNode(
  db: DatabaseSync,
  task: { node_id: number | null; role: string | null; repo: string | null },
): NodeDoc | undefined {
  if (task.node_id !== null) return nodeDoc(db, task.node_id);
  if (!task.role) return undefined;
  const match = matchRole(db, task.role, task.repo);
  return match.node ? nodeDoc(db, match.node.id) : undefined;
}
