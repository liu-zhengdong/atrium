import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { all, atomically, one } from "./ledger-model.ts";
import { GATES, isGate } from "./gates.ts";
import { ADAPTERS, checkEffort } from "./adapters/index.ts";
import { parseWorker } from "./profiles.ts";

/**
 * 专员：只记分工——一句做什么、优先执行者、验收关卡、挂哪些技能。做法与口味在技能里，规矩在要点里，
 * 这里不再有正文（旧库的 body、part_id、review_*、invite_when 列不读）。
 */
export type JobRole = {
  id: number;
  ref: string;
  name: string;
  description: string;
  preferred: string[];
  checks: string[];
  skills: string[];
  rev: number;
  created_at: number;
  updated_at: number;
  running?: number;
};
type Row = Omit<JobRole, "ref" | "preferred" | "checks" | "skills"> & {
  preferred: string;
  checks: string;
  skills: string;
};
const view = (r: Row): JobRole => ({
  id: r.id,
  ref: `r${r.id}`,
  name: r.name,
  description: r.description,
  preferred: JSON.parse(r.preferred) as string[],
  checks: JSON.parse(r.checks) as string[],
  skills: JSON.parse(r.skills) as string[],
  rev: r.rev,
  created_at: r.created_at,
  updated_at: r.updated_at,
});
const bad = (message: string): never => {
  throw new Problem(400, message, "usage");
};
export function ensureJobRoles(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS job_roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE, description TEXT NOT NULL, body TEXT NOT NULL, preferred TEXT NOT NULL, checks TEXT NOT NULL, skills TEXT NOT NULL, rev INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS job_role_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, role_id INTEGER NOT NULL REFERENCES job_roles(id), rev INTEGER NOT NULL, at INTEGER NOT NULL, author TEXT NOT NULL, snapshot TEXT NOT NULL, UNIQUE(role_id,rev));
  CREATE INDEX IF NOT EXISTS job_role_revisions_role ON job_role_revisions(role_id,rev);
  CREATE TRIGGER IF NOT EXISTS job_role_revisions_no_update BEFORE UPDATE ON job_role_revisions BEGIN SELECT RAISE(ABORT,'job role revisions append only'); END;
  CREATE TRIGGER IF NOT EXISTS job_role_revisions_no_delete BEFORE DELETE ON job_role_revisions BEGIN SELECT RAISE(ABORT,'job role revisions append only'); END;`);
}
const required = (value: unknown, flag: string, max: number) => {
  if (typeof value !== "string" || !value.trim() || [...value].length > max)
    bad(`${flag} 应为 1–${max} 字的文字`);
  return (value as string).trim();
};
const list = (value: unknown, flag: string): string[] => {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some((x) => typeof x !== "string" || !x.trim())
  )
    bad(`${flag} 应为不超过 20 项的文字列表`);
  return [...new Set((value as string[]).map((x) => x.trim()))];
};
function values(
  db: DatabaseSync,
  input: Record<string, unknown>,
  previous?: JobRole,
) {
  const name = required(input.name ?? previous?.name, "name", 100);
  const description = required(
    input.description ?? previous?.description,
    "description",
    500,
  );
  const preferred =
    input.preferred === undefined
      ? (previous?.preferred ?? [])
      : list(input.preferred, "preferred");
  for (const worker of preferred) {
    const spec = parseWorker(worker);
    checkEffort(ADAPTERS[spec.tool], spec.effort);
  }
  // 只校验这次写的；库里旧的（如已删掉的 ci）改别的字段时照留，派活时忽略。
  const checks =
    input.checks === undefined
      ? (previous?.checks ?? [])
      : list(input.checks, "checks");
  if (input.checks !== undefined)
    for (const check of checks)
      if (!isGate(check))
        bad(`checks: 未知验收关卡 ${check}，可用 ${GATES.join("、")}`);
  const skills =
    input.skills === undefined
      ? (previous?.skills ?? [])
      : list(input.skills, "skills");
  for (const slug of skills) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
      bad(`skills: 技能名不合法 ${slug}`);
    if (
      !one(
        db,
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_skills'",
      ) ||
      !one(
        db,
        "SELECT 1 FROM org_skills WHERE slug=? AND archived_at IS NULL",
        slug,
      )
    )
      bad(`skills: 技能 ${slug} 不存在`);
  }
  return { name, description, preferred, checks, skills };
}
function inputOf(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    bad("专员字段应为 JSON 对象");
  const input = body as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "name",
          "description",
          "preferred",
          "checks",
          "skills",
          "author",
        ].includes(key),
    )
  )
    bad("专员含不支持的字段");
  return input;
}
function author(input: Record<string, unknown>) {
  return input.author === undefined
    ? "u1"
    : required(input.author, "author", 100);
}
const SELECT =
  "SELECT id,name,description,preferred,checks,skills,rev,created_at,updated_at FROM job_roles";
export function listJobRoles(db: DatabaseSync) {
  return all<Row>(db, `${SELECT} ORDER BY id LIMIT 200`).map((row) => ({
    ...view(row),
    running:
      one<{ n: number }>(
        db,
        "SELECT COUNT(*) n FROM tasks WHERE job_id=? AND status='running'",
        row.id,
      )?.n ?? 0,
  }));
}
export function getJobRole(db: DatabaseSync, reference: unknown): JobRole {
  const text = String(reference ?? "").trim();
  const r = /^r([1-9]\d*)$/.exec(text);
  const row = r
    ? one<Row>(db, `${SELECT} WHERE id=?`, Number(r[1]))
    : one<Row>(db, `${SELECT} WHERE name=? COLLATE NOCASE`, text);
  if (!row)
    throw new Problem(404, `专员 ${text || "（空）"} 不存在`, "not_found");
  return view(row);
}
export function createJobRole(
  db: DatabaseSync,
  body: unknown,
  now = Date.now(),
) {
  const input = inputOf(body),
    data = values(db, input);
  return atomically(db, () => {
    if (
      one(db, "SELECT 1 FROM job_roles WHERE name=? COLLATE NOCASE", data.name)
    )
      bad(`专员名称已存在：${data.name}`);
    const id = Number(
      db
        .prepare(
          "INSERT INTO job_roles(name,description,body,preferred,checks,skills,rev,created_at,updated_at) VALUES (?,?,'',?,?,?,1,?,?)",
        )
        .run(
          data.name,
          data.description,
          JSON.stringify(data.preferred),
          JSON.stringify(data.checks),
          JSON.stringify(data.skills),
          now,
          now,
        ).lastInsertRowid,
    );
    const role = getJobRole(db, `r${id}`);
    db.prepare(
      "INSERT INTO job_role_revisions(role_id,rev,at,author,snapshot) VALUES (?,1,?,?,?)",
    ).run(id, now, author(input), JSON.stringify(role));
    return role;
  });
}
export function editJobRole(
  db: DatabaseSync,
  reference: unknown,
  body: unknown,
  now = Date.now(),
) {
  const input = inputOf(body);
  return atomically(db, () => {
    const old = getJobRole(db, reference),
      data = values(db, input, old);
    if (
      one<{ id: number }>(
        db,
        "SELECT id FROM job_roles WHERE name=? COLLATE NOCASE AND id<>?",
        data.name,
        old.id,
      )
    )
      bad(`专员名称已存在：${data.name}`);
    db.prepare(
      "UPDATE job_roles SET name=?,description=?,preferred=?,checks=?,skills=?,rev=rev+1,updated_at=? WHERE id=?",
    ).run(
      data.name,
      data.description,
      JSON.stringify(data.preferred),
      JSON.stringify(data.checks),
      JSON.stringify(data.skills),
      now,
      old.id,
    );
    const role = getJobRole(db, `r${old.id}`);
    db.prepare(
      "INSERT INTO job_role_revisions(role_id,rev,at,author,snapshot) VALUES (?,?,?,?,?)",
    ).run(role.id, role.rev, now, author(input), JSON.stringify(role));
    return role;
  });
}
export function jobRoleHistory(db: DatabaseSync, reference: unknown) {
  const role = getJobRole(db, reference);
  return all<{ rev: number; at: number; author: string; snapshot: string }>(
    db,
    "SELECT rev,at,author,snapshot FROM job_role_revisions WHERE role_id=? ORDER BY rev DESC LIMIT 100",
    role.id,
  ).map((row) => ({ ...row, snapshot: JSON.parse(row.snapshot) as JobRole }));
}
