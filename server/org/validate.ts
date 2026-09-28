import { Problem } from "../problem.ts";
import type { Kind } from "./model.ts";
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
  if (!["org", "project", "module"].includes(String(value)))
    return bad("kind", "只能是 org、project、module");
  return value as Kind;
}
export function validParent(parent: Kind, child: Kind): boolean {
  return (
    (parent === "org" && child === "project") ||
    ((parent === "project" || parent === "module") && child === "module")
  );
}
/** 上级类型决定下面能建什么类型（`org add` 不写 --kind 时的推断）；关注点已下线，下面不能再建。 */
export function childKind(parent: Kind): Kind | null {
  if (parent === "org") return "project";
  if (parent === "project" || parent === "module") return "module";
  return null;
}
/** 人话字段（是什么、怎么用、现状、阶段……）：只认 overview.ts 里的字段，逐项校验。 */
export function validateFields(value: unknown): Record<string, unknown> {
  const fields = object(value, "fields");
  for (const [key, v] of Object.entries(fields))
    if (!validateOverviewField(key, v)) bad(`fields.${key}`, "是未知字段");
  return fields;
}
