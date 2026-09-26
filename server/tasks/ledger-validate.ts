import type { DatabaseSync } from "node:sqlite";
import { isAbsolute } from "node:path";
import { TASK_STATUSES, isTaskStatus } from "./state.ts";
import { parseTaskRef, row, taskRef, usage } from "./ledger-model.ts";

const TITLE_MAX = 200;
const TEXT_MAX = 4096;

/** 任务没写负责人时，事件交给秘书。 */
export const DEFAULT_OWNER = "secretary";
const OWNER_RE = /^[\p{L}\p{N}_.-]{1,60}$/u;
export function ownerOf(value: unknown, field = "owner") {
  if (typeof value !== "string" || !OWNER_RE.test(value.trim()))
    throw usage(`${field}: 订阅者名只能用字母、数字、_ . -，1～60 字`);
  return value.trim();
}
export const optionalText = (value: unknown, field: string, max = TEXT_MAX) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw usage(`${field}: 应为文本`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw usage(`${field}: 不能超过 ${max} 字`);
  return text;
};
export const title = (value: unknown) => {
  if (typeof value !== "string" || !value.trim())
    throw usage("title: 标题不能为空");
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length > TITLE_MAX)
    throw usage(`title: 标题不能超过 ${TITLE_MAX} 字`);
  return text;
};
export const statusOf = (value: unknown, field = "status") => {
  if (!isTaskStatus(value))
    throw usage(`${field}: 只能是 ${TASK_STATUSES.join("、")}`);
  return value;
};
export const repoOf = (value: unknown) => {
  const repo = optionalText(value, "repo");
  if (repo && !isAbsolute(repo)) throw usage("repo: 应为绝对路径");
  return repo;
};
export const objectOf = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw usage("请求体应为 JSON 对象");
  return value as Record<string, unknown>;
};
export const onlyKeys = (input: Record<string, unknown>, allowed: string[]) => {
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length)
    throw usage(
      `不认识的字段：${extra.join("、")}；可用 ${allowed.join("、")}`,
    );
};
export function parentOf(db: DatabaseSync, value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const id = parseTaskRef(value, "parent");
  if (!row(db, id))
    throw usage(`parent: 父任务 ${taskRef(id)} 不存在`, "atrium task ls");
  return id;
}
