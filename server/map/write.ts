import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { nodeByAddress, one, ref, type DocRow } from "../org/model.ts";
import { addNode, editOverviewFields } from "../org/write.ts";
import { canEdit, nodes, type Kind } from "../org/model.ts";
import { appliesText, resolveApplies } from "../org/aspects.ts";
import { validateOverviewField } from "../org/overview.ts";
import { actsForUser } from "../../shared/user.ts";

/**
 * 全景图的写入（#322 第 4 步）：`map edit` 改人话字段，`map add` 在父节点下加一块。
 * 人话字段只覆盖当前值；正文仍按章程修订。权限与校验走 org/write.ts。
 */

/** 命令行参数 → 章程字段；列表给一个空串表示清空。 */
const FIELDS: Record<string, "text" | "list"> = {
  what: "text",
  alias: "text",
  analogy: "text",
  now: "text",
  next: "text",
  when: "text",
  uses: "list",
  flow: "list",
};

export type MapEdit = Partial<Record<keyof typeof FIELDS, unknown>> & {
  /** 管方面的部分缺省适用于哪些部分（#373）；空串清掉，改回整个上级。 */
  applies?: unknown;
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
    if (["detail", "reason", "rev", "applies"].includes(key)) continue;
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
  if (
    node.kind !== "concern" &&
    typeof input.when === "string" &&
    input.when.trim()
  )
    throw usage(
      `--when: 专员请用 atrium specialist edit <专员> --invite-when 修改；${ref(node.id)} ${node.name} 是组织节点`,
    );
  const doc = one<DocRow>(
    db,
    "SELECT * FROM org_docs WHERE node_id=? AND doc='charter'",
    node.id,
  );
  const current = doc
    ? (JSON.parse(doc.fields) as Record<string, unknown>)
    : {};
  const fields = mergeFields(current, input as Record<string, unknown>);
  const applies =
    input.applies === undefined
      ? undefined
      : appliesText(resolveApplies(db, input.applies));
  if (applies !== undefined && !node.aspect)
    throw usage(
      `--applies: ${ref(node.id)} ${node.name} 不是管方面的部分；管东西的部分的要点只对本块及下层生效`,
    );
  const appliesChanged =
    applies !== undefined && applies !== (node.applies ?? null);
  const changed =
    appliesChanged ||
    JSON.stringify(fields) !== JSON.stringify(current) ||
    (input.detail !== undefined && input.detail !== (doc?.body ?? ""));
  if (!changed)
    throw usage(
      "没有要改的：给 --what、--uses、--flow、--alias、--analogy、--now、--next、--when、--applies 或 --detail 文件",
    );
  if (input.rev !== undefined && input.detail === undefined)
    throw usage("--rev: 只用于 --detail 修改章程正文");
  if (appliesChanged) {
    if (
      (node.parent_id === null && !actsForUser(actor)) ||
      !canEdit(nodes(db), node, actor)
    )
      throw new Problem(
        403,
        `--applies 无权限：${actor} 不是 ${ref(node.id)} 的 leader 或祖先 leader`,
      );
    db.prepare("UPDATE org_nodes SET applies=?,updated_at=? WHERE id=?").run(
      applies,
      Date.now(),
      node.id,
    );
    const rest = Object.keys(input).filter(
      (k) =>
        k !== "applies" && (input as Record<string, unknown>)[k] !== undefined,
    );
    if (!rest.length) return { node: ref(node.id) };
  }
  return editOverviewFields(
    db,
    ref(node.id),
    fields,
    actor,
    input.detail === undefined
      ? undefined
      : {
          body: input.detail,
          rev: typeof input.rev === "string" ? input.rev : undefined,
          reason:
            typeof input.reason === "string" && input.reason.trim()
              ? input.reason
              : "改全景技术细节（atrium map edit --detail）",
        },
  );
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

/** 在父节点下加一块：建节点留节点修订；人话字段只写当前值。 */
export function addMap(db: DatabaseSync, input: MapAdd, actor: string) {
  const parent = nodeByAddress(db, String(input.parent ?? ""));
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw usage("名称不能为空");
  const kind = (input.kind ?? CHILD[parent.kind]) as Kind | "aspect" | null;
  if (!kind || parent.kind === "concern")
    throw usage(`${ref(parent.id)} 是关注点，下面不能再加部分`);
  if (kind === "concern")
    throw usage("关注点节点已下线；请用 atrium specialist add 创建专员");
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
  ) as { id: number; kind: Kind };
  if (Object.keys(fields).length)
    editOverviewFields(db, ref(created.id), fields, actor);
  return {
    node: ref(created.id),
    parent: ref(parent.id),
    name,
    kind: created.kind,
    aspect: kind === "aspect",
    slug,
  };
}
