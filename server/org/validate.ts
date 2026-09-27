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
  const rules: Record<string, number> =
    doc === "charter"
      ? { goal: 300, report: 200, escalate: 200 }
      : { status: 300 };
  const lists: Record<string, number> =
    doc === "card" ? { owns: 10, accepts: 10, asks: 5 } : {};
  for (const [key, v] of Object.entries(fields)) {
    const field = `${doc}.${key}`;
    if (doc === "charter" && validateOverviewField(key, v)) continue;
    if (Object.hasOwn(rules, key)) text(v, field, rules[key]!);
    else if (Object.hasOwn(lists, key)) {
      if (!Array.isArray(v)) bad(field, "应为文本列表");
      const entries = v as unknown[];
      if (entries.length > lists[key]!) bad(field, `超过 ${lists[key]} 项`);
      entries.forEach((item, i) => text(item, `${field}[${i}]`, 300));
    } else if (doc === "card" && key === "commitments") {
      if (!Array.isArray(v)) bad(field, "应为承诺列表");
      const entries = v as unknown[];
      if (entries.length > 10) bad(field, "超过 10 项");
      entries.forEach((item, i) => {
        const entry = object(item, `${field}[${i}]`);
        for (const k of Object.keys(entry))
          if (!["id", "text", "due"].includes(k))
            bad(`${field}[${i}].${k}`, "是未知字段");
        text(entry.id, `${field}[${i}].id`, 40);
        text(entry.text, `${field}[${i}].text`, 300);
        if (
          entry.due !== undefined &&
          (typeof entry.due !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(entry.due) ||
            Number.isNaN(Date.parse(entry.due)) ||
            new Date(entry.due).toISOString().slice(0, 10) !== entry.due)
        )
          bad(`${field}[${i}].due`, "应为 YYYY-MM-DD 日期");
      });
    } else bad(field, "是未知字段");
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
  let budget: unknown;
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
  ) {
    const { budget: shares, ...rest } = fields as Record<string, unknown>;
    budget = shares;
    fields = rest;
  }
  return {
    fields: validateFields(doc, fields),
    body: validateBody(source.slice(end + 5)),
    ...(boundaries === undefined ? {} : { boundaries }),
    ...(budget === undefined ? {} : { budget }),
  };
}
export function exportDocument(
  fields: Record<string, unknown>,
  body: string,
  boundaries?: unknown[],
  budget?: Record<string, unknown>,
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
  if (budget && Object.keys(budget).length)
    lines.push(YAML.stringify({ budget }, { lineWidth: 0 }).trimEnd());
  return `---\n${lines.join("\n")}\n---\n${body}`;
}
