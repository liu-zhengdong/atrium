import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { nodeByAddress, one, ref, type DocRow } from "../org/model.ts";
import { addNode, editDoc } from "../org/write.ts";
import type { Kind } from "../org/model.ts";
import { validateOverviewField } from "../org/overview.ts";

/**
 * 全景图的写入（#322 第 4 步）：`map edit` 改人话字段，`map add` 在父节点下加一块。
 * 只是章程与节点写入的简写：权限、校验、修订历史都走 org/write.ts（负责部门 leader 或其上级；根只有 u1）。
 */

/** 命令行参数 → 章程字段；列表给一个空串表示清空。 */
const FIELDS: Record<string, "text" | "list"> = {
  what: "text",
  alias: "text",
  analogy: "text",
  now: "text",
  next: "text",
  uses: "list",
  flow: "list",
};

export type MapEdit = Partial<Record<keyof typeof FIELDS, unknown>> & {
  detail?: unknown;
  reason?: unknown;
  rev?: unknown;
};

const usage = (message: string) => new Problem(400, message, "usage");

/** 纯函数：把给了的字段并进原章程字段；没给的不动，空串清掉。 */
export function mergeFields(
  current: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...current };
  for (const key of Object.keys(input)) {
    if (["detail", "reason", "rev"].includes(key)) continue;
    const type = FIELDS[key];
    if (!type) throw usage(`--${key}: 不是全景字段`);
    const value = input[key];
    if (value === undefined) continue;
    if (type === "text") {
      if (typeof value !== "string") throw usage(`--${key}: 应为文本`);
      if (value.trim()) next[key] = value.trim();
      else delete next[key];
    } else {
      const list = (Array.isArray(value) ? value : [value]).map((v) => {
        if (typeof v !== "string") throw usage(`--${key}: 应为文本`);
        return v.trim();
      });
      const kept = list.filter(Boolean);
      if (kept.length) next[key] = kept;
      else delete next[key];
    }
  }
  return next;
}

export function editMap(
  db: DatabaseSync,
  address: string,
  input: MapEdit,
  actor: string,
) {
  const node = nodeByAddress(db, address);
  const doc = one<DocRow>(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
    node.id,
  );
  const current = doc
    ? (JSON.parse(doc.fields) as Record<string, unknown>)
    : {};
  const fields = mergeFields(current, input as Record<string, unknown>);
  const changed =
    JSON.stringify(fields) !== JSON.stringify(current) ||
    (input.detail !== undefined && input.detail !== (doc?.body ?? ""));
  if (!changed)
    throw usage(
      "没有要改的：给 --what、--uses、--flow、--alias、--analogy、--now、--next 或 --detail 文件",
    );
  const result = editDoc(
    db,
    ref(node.id),
    "charter",
    {
      fields,
      body: input.detail ?? doc?.body ?? "",
      rev: typeof input.rev === "string" ? input.rev : undefined,
      reason:
        typeof input.reason === "string" && input.reason.trim()
          ? input.reason
          : "改全景人话字段（atrium map edit）",
    },
    actor,
  );
  return { node: ref(node.id), before: result.before, rev: result.rev };
}

const CHILD: Record<Kind, Kind | null> = {
  org: "project",
  project: "module",
  module: "module",
  concern: null,
};

export type MapAdd = {
  parent: string;
  name: string;
  slug?: string;
  kind?: string;
  alias?: string;
  analogy?: string;
  what?: string;
  reason?: string;
};

/** 在父节点下加一块：建节点（修订 r1），给了人话字段再写一版章程。 */
export function addMap(db: DatabaseSync, input: MapAdd, actor: string) {
  const parent = nodeByAddress(db, String(input.parent ?? ""));
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw usage("名称不能为空");
  const kind = (input.kind ?? CHILD[parent.kind]) as Kind | null;
  if (!kind) throw usage(`${ref(parent.id)} 是关注点，下面不能再加部分`);
  const slug = (input.slug ?? name).trim().toLowerCase();
  if (!/^(?:[a-z0-9-]|[㐀-鿿])+$/.test(slug))
    throw usage(
      `--slug: 名称「${name}」不能直接当路径名，请给 --slug（小写英数、连字符或中文）`,
    );
  const reason =
    typeof input.reason === "string" && input.reason.trim()
      ? input.reason
      : "全景图加一块（atrium map add）";
  const fields = mergeFields(
    {},
    Object.fromEntries(
      (["alias", "analogy", "what"] as const)
        .filter((k) => input[k] !== undefined)
        .map((k) => [k, input[k]]),
    ),
  );
  for (const [key, value] of Object.entries(fields))
    validateOverviewField(key, value);
  const created = addNode(
    db,
    { parent: ref(parent.id), slug, kind, name, reason },
    actor,
  ) as { id: number };
  if (Object.keys(fields).length)
    editDoc(
      db,
      ref(created.id),
      "charter",
      { fields, body: "", reason },
      actor,
    );
  return { node: ref(created.id), parent: ref(parent.id), name, kind, slug };
}
