import YAML from "yaml";
import { Problem } from "../problem.ts";
import type { Doc, Kind } from "./model.ts";
import { validateOverviewField } from "./overview.ts";

const bad = (field: string, message: string) => {
  throw new Problem(400, `${field} ${message}`, "usage");
};
const object = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return bad(field, "应为对象");
  return value as Record<string, unknown>;
};
const text = (value: unknown, field: string, max: number) => {
  if (typeof value !== "string") return bad(field, "应为文本");
  if (Array.from(value).length > max) return bad(field, `超过 ${max} 字`);
  return value;
};
export function validateSlug(value: unknown): string {
  const slug = text(value, "slug", 40);
  if (!slug || !/^(?:[a-z0-9-]|[\u3400-\u9fff])+$/.test(slug))
    return bad("slug", "只能用小写英数、连字符或中文，长度 1–40 字");
  return slug;
}
export function validateReason(value: unknown): string {
  const reason = text(value, "reason", 500).trim();
  if (!reason) return bad("reason", "不能为空");
  return reason;
}
export function validateKind(value: unknown): Kind {
  if (!["org", "project", "module", "concern"].includes(String(value)))
    return bad("kind", "只能是 org、project、module、concern");
  return value as Kind;
}
export function validParent(parent: Kind, child: Kind): boolean {
  return (
    (parent === "org" && child === "project") ||
    (parent === "project" && (child === "module" || child === "concern")) ||
    (parent === "module" && (child === "module" || child === "concern"))
  );
}
export function validateFields(
  doc: Doc,
  value: unknown,
): Record<string, unknown> {
  const fields = object(value, doc);
  const rules: Record<string, number> = {
    goal: 300,
    report: 200,
    escalate: 200,
  };
  for (const [key, v] of Object.entries(fields)) {
    const field = `${doc}.${key}`;
    if (validateOverviewField(key, v)) continue;
    if (Object.hasOwn(rules, key)) text(v, field, rules[key]!);
    else bad(field, "是未知字段");
  }
  return fields;
}
export function validateBody(value: unknown): string {
  if (typeof value !== "string") return bad("body", "应为文本");
  if (Buffer.byteLength(value, "utf8") > 16 * 1024)
    return bad("body", "超过 16 KB");
  return value;
}
/** Parse YAML frontmatter strictly; the exported JSON scalars are valid YAML too. */
export function parseDocument(source: string, doc: Doc) {
  if (!source.startsWith("---\n")) return bad(doc, "frontmatter 缺少开头 ---");
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) return bad(doc, "frontmatter 缺少结尾 ---");
  let fields: unknown;
  try {
    const parsed = YAML.parseDocument(source.slice(4, end), {
      uniqueKeys: true,
    });
    if (parsed.errors.length) return bad(doc, "frontmatter 格式错误");
    fields = parsed.toJS({ maxAliasCount: 100 }) ?? {};
  } catch {
    return bad(doc, "frontmatter 格式错误");
  }
  // 章程的 boundaries 单独成表，不进 fields；不写表示不改
  let boundaries: unknown;
  if (
    doc === "charter" &&
    fields &&
    typeof fields === "object" &&
    !Array.isArray(fields) &&
    Object.hasOwn(fields, "boundaries")
  ) {
    const { boundaries: list, ...rest } = fields as Record<string, unknown>;
    boundaries = list ?? [];
    fields = rest;
  }
  if (
    doc === "charter" &&
    fields &&
    typeof fields === "object" &&
    !Array.isArray(fields) &&
    Object.hasOwn(fields, "budget")
  )
    return bad(
      "charter.budget",
      "预算份额已下线；给用户保留的额度与花费上限写在 boundaries 的 param（quota_reserve_percent、money_yuan_max）",
    );
  return {
    fields: validateFields(doc, fields),
    body: validateBody(source.slice(end + 5)),
    ...(boundaries === undefined ? {} : { boundaries }),
  };
}
export function exportDocument(
  fields: Record<string, unknown>,
  body: string,
  boundaries?: unknown[],
): string {
  // 阶段记录是对象列表，按 YAML 块写出好读好改；其余字段沿用单行 JSON 标量
  const lines = Object.entries(fields).map(([k, v]) =>
    k === "stages" && Array.isArray(v) && v.length
      ? YAML.stringify({ [k]: v }, { lineWidth: 0 }).trimEnd()
      : `${k}: ${JSON.stringify(v)}`,
  );
  if (boundaries)
    lines.push(
      boundaries.length
        ? YAML.stringify({ boundaries }, { lineWidth: 0 }).trimEnd()
        : "boundaries: []",
    );
  return `---\n${lines.join("\n")}\n---\n${body}`;
}
