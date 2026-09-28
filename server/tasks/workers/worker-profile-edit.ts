import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../../problem.ts";
import { syncFromRules } from "../adapters/custom.ts";
import { parseProfileSource } from "./profiles.ts";
import { toolProblems } from "./profile-tool-check.ts";
import {
  listProfiles,
  parseProfileRef,
  patchFront,
  profileHistory,
  readProfile,
  sourceProblems,
  writeProfile,
  type StoredProfile,
} from "./worker-profiles.ts";

/**
 * `atrium workers / workers edit` 的服务端（#355）：列出库里的档案、看一份档案与修订、整份替换或按字段改。
 * 存储在 worker-profiles.ts，解析在 profiles.ts；这里只做校验与视图。
 */

const KEY_RE = /^[A-Za-z_][\w-]*$/;

function summary(row: StoredProfile) {
  const parsed = parseProfileSource(row.source);
  return {
    ref: `${row.layer}/${row.name}`,
    layer: row.layer,
    name: row.name,
    rev: row.rev,
    trust: parsed.rules.trust ?? null,
    max_risk: parsed.rules.max_risk ?? null,
    model: parsed.rules.model ?? null,
    checks: parsed.rules.checks ?? null,
    // 通用执行者（t271）与自定义端点：地址不是密钥，照常显示。
    protocol:
      typeof parsed.rules.protocol === "string" ? parsed.rules.protocol : null,
    endpoint:
      typeof parsed.rules.endpoint === "string" ? parsed.rules.endpoint : null,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
    warnings: parsed.warnings,
  };
}

export const listProfileViews = (db: DatabaseSync) =>
  listProfiles(db).map(summary);

export function profileView(db: DatabaseSync, ref: string) {
  const { layer, name } = parseProfileRef(ref);
  const row = readProfile(db, layer, name);
  if (!row)
    throw new Problem(
      404,
      `档案 ${layer}/${name} 不存在`,
      "not_found",
      undefined,
      "atrium workers --profiles",
    );
  const parsed = parseProfileSource(row.source);
  return {
    ...summary(row),
    rules: parsed.rules,
    body: parsed.body,
    notes: parsed.notes,
    source: row.source,
    history: profileHistory(db, layer, name).map(({ source, ...rest }) => ({
      ...rest,
      bytes: Buffer.byteLength(source, "utf8"),
    })),
  };
}

type Body = {
  source?: unknown;
  set?: unknown;
  unset?: unknown;
  reason?: unknown;
};

/** 整份替换（source）或按字段改（set / unset）；校验不过报 400，内容没变不留修订。 */
export function editProfile(
  db: DatabaseSync,
  ref: string,
  body: unknown,
  author: string,
) {
  const { layer, name } = parseProfileRef(ref);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Problem(400, "请求体应为 JSON 对象", "usage");
  const b = body as Body;
  const set =
    b.set && typeof b.set === "object" && !Array.isArray(b.set)
      ? Object.entries(b.set as Record<string, unknown>)
      : [];
  const unset = Array.isArray(b.unset) ? b.unset : [];
  const hasSource = typeof b.source === "string";
  if (hasSource === set.length + unset.length > 0)
    throw new Problem(
      400,
      "--file 与字段参数（--trust、--max-risk、--model、--checks、--set、--unset）二选一，且至少给一个",
      "usage",
    );
  const current = readProfile(db, layer, name);
  let source: string;
  if (hasSource) source = b.source as string;
  else {
    source = current?.source ?? "";
    for (const [key, value] of set) {
      if (!KEY_RE.test(key))
        throw new Problem(400, `--set 的键不合法：${key}`, "usage");
      if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value))
        throw new Problem(400, `--set ${key} 的值须是一行非空文字`, "usage");
      source = patchFront(source, key, value.trim());
    }
    for (const key of unset) {
      if (typeof key !== "string" || !KEY_RE.test(key))
        throw new Problem(400, `--unset 的键不合法：${String(key)}`, "usage");
      source = patchFront(source, key, undefined);
    }
  }
  // 只拒这次新引入的问题；库里原有的（如已删掉的 ci 关卡）不挡改别的字段，`atrium workers` 照样提示。
  const before = new Set(
    current ? parseProfileSource(current.source).warnings : [],
  );
  const parsed = parseProfileSource(source);
  const problems = [
    ...sourceProblems(source),
    ...parsed.warnings.filter((w) => !before.has(w)),
    ...toolProblems(layer, name, parsed.rules),
  ];
  if (problems.length)
    throw new Problem(
      400,
      `档案 ${layer}/${name} 没改：${problems.join("；")}`,
      "usage",
    );
  const reason =
    typeof b.reason === "string" && b.reason.trim()
      ? b.reason.trim().slice(0, 500)
      : hasSource
        ? "整份替换"
        : `改字段 ${[...set.map(([k]) => k), ...unset].join("、")}`;
  const result = writeProfile(db, { layer, name, source, author, reason });
  // 通用执行者（t271）：改完即登记，派活、task run --dry-run 马上认得这个名字。
  if (layer === "harness") syncFromRules(name, parsed.rules);
  return { ref: `${layer}/${name}`, ...result };
}
