import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { all, atomically, one } from "./ledger-model.ts";
import { GATES } from "./gates.ts";
import { ADAPTERS, checkEffort } from "./adapters/index.ts";
import { parseWorker } from "./profiles.ts";
import { nodeByAddress } from "../org/model.ts";

export type JobRole = {
  id: number;
  ref: string;
  name: string;
  /** 归属哪一部分（#373）：空为全组织共用。 */
  part_id: number | null;
  part: string | null;
  part_name: string | null;
  description: string;
  body: string;
  preferred: string[];
  checks: string[];
  skills: string[];
  review_goal: string;
  review_points: { ref: string; text: string; why: string }[];
  review_bottom: string[];
  invite_when: string[];
  rev: number;
  created_at: number;
  updated_at: number;
  running?: number;
};
type Row = Omit<
  JobRole,
  | "ref"
  | "part"
  | "part_name"
  | "preferred"
  | "checks"
  | "skills"
  | "review_points"
  | "review_bottom"
  | "invite_when"
> & {
  preferred: string;
  checks: string;
  skills: string;
  review_points: string;
  review_bottom: string;
  invite_when: string;
};
const view = (r: Row & { part_name?: string | null }): JobRole => ({
  ...r,
  ref: `r${r.id}`,
  part_id: r.part_id ?? null,
  part: r.part_id ? `o${r.part_id}` : null,
  part_name: r.part_name ?? null,
  preferred: JSON.parse(r.preferred) as string[],
  checks: JSON.parse(r.checks) as string[],
  skills: JSON.parse(r.skills) as string[],
  review_points: JSON.parse(r.review_points) as JobRole["review_points"],
  review_bottom: JSON.parse(r.review_bottom) as string[],
  invite_when: JSON.parse(r.invite_when) as string[],
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
  const columns = db.prepare("PRAGMA table_info(job_roles)").all() as {
    name: string;
  }[];
  for (const [name, definition] of [
    ["review_goal", "TEXT NOT NULL DEFAULT ''"],
    ["review_points", "TEXT NOT NULL DEFAULT '[]'"],
    ["review_bottom", "TEXT NOT NULL DEFAULT '[]'"],
    ["invite_when", "TEXT NOT NULL DEFAULT '[]'"],
    // 专员归属（#373）：指向 org_nodes.id；旧专员留空，即全组织共用，行为不变。
    ["part_id", "INTEGER"],
  ])
    if (!columns.some((column) => column.name === name))
      db.exec(`ALTER TABLE job_roles ADD COLUMN ${name} ${definition}`);
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
  const body = required(input.body ?? previous?.body, "body", 16000);
  const preferred =
    input.preferred === undefined
      ? (previous?.preferred ?? [])
      : list(input.preferred, "preferred");
  for (const worker of preferred) {
    const spec = parseWorker(worker);
    checkEffort(ADAPTERS[spec.tool], spec.effort);
  }
  const checks =
    input.checks === undefined
      ? (previous?.checks ?? [])
      : list(input.checks, "checks");
  for (const check of checks)
    if (!(GATES as readonly string[]).includes(check))
      bad(`checks: 未知验收关卡 ${check}`);
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
  const review_goal =
    input.review_goal === undefined
      ? (previous?.review_goal ?? "")
      : typeof input.review_goal === "string" && input.review_goal.length <= 300
        ? input.review_goal.trim()
        : bad("review_goal 应为不超过 300 字的文字");
  const review_points =
    input.review_points === undefined
      ? (previous?.review_points ?? [])
      : Array.isArray(input.review_points) &&
          input.review_points.length <= 30 &&
          input.review_points.every(
            (p) =>
              p &&
              typeof p === "object" &&
              typeof p.ref === "string" &&
              typeof p.text === "string" &&
              typeof p.why === "string",
          )
        ? (input.review_points as JobRole["review_points"])
        : bad("review_points 应为不超过 30 条检查要点");
  const review_bottom =
    input.review_bottom === undefined
      ? (previous?.review_bottom ?? [])
      : list(input.review_bottom, "review_bottom");
  const invite_when =
    input.invite_when === undefined
      ? (previous?.invite_when ?? [])
      : list(input.invite_when, "invite_when");
  const part_id =
    input.part === undefined
      ? (previous?.part_id ?? null)
      : partOf(db, input.part);
  return {
    name,
    part_id,
    description,
    body,
    preferred,
    checks,
    skills,
    review_goal,
    review_points,
    review_bottom,
    invite_when,
  };
}
/** 专员归属的部分：节点地址，空为全组织。 */
function partOf(db: DatabaseSync, value: unknown): number | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return bad("part 应为部分（o20 或名称）");
  if (
    !one(
      db,
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_nodes'",
    )
  )
    return bad("part: 还没有组织树");
  let node;
  try {
    node = nodeByAddress(db, value.trim());
  } catch (error) {
    if (error instanceof Problem)
      throw new Problem(
        400,
        `part: ${error.message}`,
        "usage",
        error.candidates,
        "atrium org tree",
      );
    throw error;
  }
  if (node.archived_at !== null)
    return bad(`part: ${node.name}（o${node.id}）已归档`);
  return node.id;
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
          "body",
          "preferred",
          "checks",
          "skills",
          "review_goal",
          "review_points",
          "review_bottom",
          "invite_when",
          "part",
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
const hasOrgNodes = (db: DatabaseSync) =>
  !!one(
    db,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_nodes'",
  );
/** 带上归属部分的名称；没有组织树时只给短号。 */
const SELECT = (db: DatabaseSync) =>
  hasOrgNodes(db)
    ? "SELECT j.*, n.name AS part_name FROM job_roles j LEFT JOIN org_nodes n ON n.id=j.part_id"
    : "SELECT j.*, NULL AS part_name FROM job_roles j";
export function listJobRoles(db: DatabaseSync) {
  return all<Row>(db, `${SELECT(db)} ORDER BY j.id LIMIT 200`).map((row) => ({
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
    ? one<Row>(db, `${SELECT(db)} WHERE j.id=?`, Number(r[1]))
    : one<Row>(db, `${SELECT(db)} WHERE j.name=? COLLATE NOCASE`, text);
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
          "INSERT INTO job_roles(name,part_id,description,body,preferred,checks,skills,review_goal,review_points,review_bottom,invite_when,rev,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)",
        )
        .run(
          data.name,
          data.part_id,
          data.description,
          data.body,
          JSON.stringify(data.preferred),
          JSON.stringify(data.checks),
          JSON.stringify(data.skills),
          data.review_goal,
          JSON.stringify(data.review_points),
          JSON.stringify(data.review_bottom),
          JSON.stringify(data.invite_when),
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
      "UPDATE job_roles SET name=?,part_id=?,description=?,body=?,preferred=?,checks=?,skills=?,review_goal=?,review_points=?,review_bottom=?,invite_when=?,rev=rev+1,updated_at=? WHERE id=?",
    ).run(
      data.name,
      data.part_id,
      data.description,
      data.body,
      JSON.stringify(data.preferred),
      JSON.stringify(data.checks),
      JSON.stringify(data.skills),
      data.review_goal,
      JSON.stringify(data.review_points),
      JSON.stringify(data.review_bottom),
      JSON.stringify(data.invite_when),
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
