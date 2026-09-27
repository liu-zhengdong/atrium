import type { DatabaseSync } from "node:sqlite";
import { taskPeople } from "./who.ts";
import { Problem } from "../problem.ts";
import { all, nodes, one } from "../org/model.ts";
import { getJobRole, listJobRoles } from "../tasks/job-roles.ts";
import type { Delivery, WorkerStat } from "../tasks/delivery-records.ts";
import {
  parseWorker,
  resolveWorker,
  type ProfileLayer,
} from "../tasks/profiles.ts";
import { workerReport, workersReport } from "../tasks/workers-report.ts";
import {
  jobNames,
  taskColumns,
  taskView,
  type LiveRow,
  type TaskRow,
} from "./view.ts";

/**
 * 全景网页的专员、技能、执行者视图（只读）：组织根的三个页签与专员页、执行者页。
 * 数据来自专员表、组织技能、交付记录与执行者档案（`atrium specialist`、`atrium workers` 同一份），
 * 这里只挑网页要的字段并把事实翻成人话（结果标签、经过、观察），判定写成纯函数。
 */

const hasTable = (db: DatabaseSync, name: string) =>
  !!one(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?",
    name,
  );

// ---- 技能 ----

type SkillBrief = {
  slug: string;
  name: string;
  description: string;
  /** 挂在哪：专员（role）或组织节点（part，人话名优先）。 */
  on: { kind: "role" | "part"; ref: string; name: string }[];
  /** 最近一次修订：时间、谁、为什么。 */
  last: { at: number; author: string; reason: string } | null;
};

export function mapSkills(db: DatabaseSync): { skills: SkillBrief[] } {
  if (!hasTable(db, "org_skills")) return { skills: [] };
  const list = nodes(db);
  const alias = new Map(
    all<{ node_id: number; fields: string }>(
      db,
      "SELECT node_id,fields FROM org_docs WHERE doc='charter' LIMIT 600",
    ).map((r) => {
      try {
        const a = (JSON.parse(r.fields) as { alias?: unknown }).alias;
        return [r.node_id, typeof a === "string" ? a.trim() : ""] as const;
      } catch {
        return [r.node_id, ""] as const;
      }
    }),
  );
  const roles = hasTable(db, "job_roles") ? listJobRoles(db) : [];
  const skills = all<{
    id: number;
    slug: string;
    name: string;
    description: string;
  }>(
    db,
    "SELECT id,slug,name,description FROM org_skills WHERE archived_at IS NULL ORDER BY slug LIMIT 200",
  ).map((s) => {
    const parts = all<{ node_id: number }>(
      db,
      "SELECT node_id FROM org_skill_bindings WHERE skill_id=? ORDER BY node_id LIMIT 50",
      s.id,
    ).flatMap(({ node_id }) => {
      const n = list.find((x) => x.id === node_id);
      return n && n.archived_at === null
        ? [
            {
              kind: "part" as const,
              ref: `o${n.id}`,
              name: alias.get(n.id) || n.name,
            },
          ]
        : [];
    });
    const last = one<{ at: number; author: string; reason: string }>(
      db,
      "SELECT at,author,reason FROM org_skill_revisions WHERE skill_id=? ORDER BY rev DESC LIMIT 1",
      s.id,
    );
    return {
      slug: s.slug,
      name: s.name,
      description: s.description,
      on: [
        ...roles
          .filter((r) => r.skills.includes(s.slug))
          .map((r) => ({ kind: "role" as const, ref: r.ref, name: r.name })),
        ...parts,
      ],
      last: last ?? null,
    };
  });
  return { skills };
}

// ---- 专员 ----

export function mapRoles(db: DatabaseSync) {
  if (!hasTable(db, "job_roles")) return { roles: [] };
  return {
    roles: listJobRoles(db).map((r) => ({
      ref: r.ref,
      name: r.name,
      description: r.description,
      preferred: r.preferred,
      checks: r.checks,
      skills: r.skills,
      running: r.running ?? 0,
    })),
  };
}

/** 专员页：专员本身、它名下的任务（与各部分任务表同一形状）、谁做得好、挂的技能。 */
export async function mapRole(
  db: DatabaseSync,
  address: string,
  live: readonly LiveRow[] = [],
) {
  if (!hasTable(db, "job_roles"))
    throw new Problem(404, `专员 ${address} 不存在`, "not_found");
  const role = getJobRole(db, address);
  const liveBy = new Map(live.map((row) => [row.ref, row]));
  const jobs = jobNames(db);
  const rows = all<TaskRow>(
    db,
    `SELECT ${taskColumns(db)} FROM tasks WHERE job_id=?
      ORDER BY CASE WHEN status='running' THEN 0 WHEN status='blocked' THEN 1 WHEN status='todo' THEN 2 ELSE 3 END,
        updated_at DESC LIMIT 60`,
    role.id,
  );
  const who = taskPeople(
    db,
    rows.map((r) => r.id),
  );
  const tasks = rows.map((r) =>
    taskView(r, liveBy.get(`t${r.id}`), jobs, who.get(r.id)),
  );
  const report = await workersReport(db, role.ref);
  const skills = mapSkills(db).skills.filter((s) =>
    role.skills.includes(s.slug),
  );
  return {
    ref: role.ref,
    name: role.name,
    description: role.description,
    preferred: role.preferred,
    checks: role.checks,
    review_goal: role.review_goal,
    review_points: role.review_points,
    review_bottom: role.review_bottom,
    invite_when: role.invite_when,
    skills,
    tasks,
    workers: combinations(report.stats),
    suggestions: report.suggestions.map(adviceView),
  };
}

// ---- 执行者 ----

/** 按组合的行；只有在做、还没结束过一次的不算一行。 */
const combinations = (stats: readonly WorkerStat[]) =>
  stats.filter((s) => s.scope === "combination" && s.deliveries > 0);

type Advice = Awaited<ReturnType<typeof workersReport>>["suggestions"][number];
const adviceView = ({ stat, advice }: Advice) => ({
  worker: stat.worker,
  role: stat.role,
  action: advice.action,
  reason: advice.reason,
});

/** 执行者页签：一行 = 组合 × 专员；按专员筛选时只留该专员。另给待秘书确认的升降建议。 */
export async function mapWorkers(db: DatabaseSync, role?: string) {
  if (!hasTable(db, "task_deliveries"))
    return { role: null, rows: [], suggestions: [] };
  const report = await workersReport(db, role || undefined);
  return {
    role: report.role ? { ref: report.role.ref, name: report.role.name } : null,
    rows: combinations(report.stats),
    suggestions: report.suggestions.map(adviceView),
  };
}

export type Tone = "green" | "amber" | "orange" | "blue" | "gray";

/** 一次交付的结果标签（纯函数）：先看结局，再看打回次数与上线后的标注。 */
export function deliveryResult(
  d: Pick<
    Delivery,
    | "final_result"
    | "first_pass"
    | "gate_return_count"
    | "merge_returns"
    | "verdict"
    | "ended_at"
  >,
): { label: string; tone: Tone } {
  if (d.verdict === "rejected") return { label: "被你否掉", tone: "orange" };
  const returns = d.gate_return_count + d.merge_returns.length;
  switch (d.final_result) {
    case "失败":
      return { label: "没交付", tone: "orange" };
    case "换人":
      return { label: "换人", tone: "orange" };
    case "受阻":
      return { label: "卡住", tone: "orange" };
    case "合入退回":
      return { label: "合入退回", tone: "orange" };
    case "取消":
      return { label: "取消", tone: "gray" };
    case "变基冲突":
      return { label: "合入冲突", tone: "gray" };
  }
  if (d.ended_at === null) return { label: "进行中", tone: "green" };
  if (d.verdict === "fixed") return { label: "上线后返修", tone: "amber" };
  if (returns > 0)
    return {
      label: `打回 ${returns} 次`,
      tone: returns > 1 ? "orange" : "amber",
    };
  if (d.first_pass) return { label: "一次通过", tone: "green" };
  return d.final_result === "已合入"
    ? { label: "已合入", tone: "gray" }
    : { label: "等合入", tone: "blue" };
}

/** 关卡名的说法（与网页「交付要求」一致）。 */
const GATE_LABEL: Record<string, string> = {
  pr_exists: "开 PR",
  local_check: "本地检查",
  ci: "远端检查",
  finished: "提交推送",
  file_growth: "文件膨胀",
  claims_verified: "汇报属实",
  screenshot: "附截图",
};
/** 交付记录里的「关卡：证据」→ 证据本身；证据缺省时说哪一关没过。 */
function gateReason(text: string) {
  const at = text.indexOf("：");
  const gate = at < 0 ? text : text.slice(0, at);
  const evidence = at < 0 ? "" : text.slice(at + 1).trim();
  const label = GATE_LABEL[gate] ?? gate;
  return !evidence || evidence === "未过" ? `${label}没过` : evidence;
}

/** 一次交付的经过（纯函数）：事故、打回原因、合入退回、冲突（不算执行者的）、秘书标注；没有就是空串。 */
export function deliveryStory(
  d: Pick<
    Delivery,
    | "incidents"
    | "gate_returns"
    | "merge_returns"
    | "rebase_conflicts"
    | "verdict_note"
  >,
): string {
  return [
    d.incidents.length ? `出事：${d.incidents.join("、")}` : "",
    d.gate_returns.length
      ? `验收没过：${d.gate_returns.map(gateReason).join("；")}`
      : "",
    d.merge_returns.length ? `合入退回：${d.merge_returns.join("；")}` : "",
    d.rebase_conflicts
      ? `合入时和别人冲突 ${d.rebase_conflicts} 次（不算它的）`
      : "",
    d.verdict_note ?? "",
  ]
    .filter(Boolean)
    .join("；");
}

export type Note = { date: string; text: string; by: string };

/**
 * 档案正文里的观察（纯函数）：一行或一段以「（2026-09-27 观察：…）」「（2026-09-27：…）」开头的记录。
 * 冒号前写了人（「你纠正」「用户定」「秘书」）就用它，没写或只写「观察」算秘书记的（档案由秘书维护）。
 * 新的在前；同一天按档案里的先后。
 */
export function profileNotes(layers: readonly Pick<ProfileLayer, "body">[]) {
  const notes: (Note & { at: string; seq: number })[] = [];
  const re =
    /^[（(](\d{4})-(\d{2})-(\d{2})\s*([^：:（）()]{0,12})[：:]\s*([\s\S]+?)[）)]?\s*$/;
  for (const layer of layers)
    for (const block of layer.body.split(/\n\s*\n|\n(?=[（(]\d{4}-)/)) {
      const m = re.exec(block.trim());
      if (!m) continue;
      const tag = m[4]!.trim();
      const by =
        !tag || tag === "观察"
          ? "秘书"
          : tag.replace(/^u1|^用户/, "你").replace(/观察$/, "") || "秘书";
      notes.push({
        at: `${m[1]}-${m[2]}-${m[3]}`,
        date: `${m[2]}-${m[3]}`,
        text: m[5]!.replace(/\s*\n\s*/g, " ").trim(),
        by,
        seq: notes.length,
      });
    }
  return notes
    .sort((a, b) => b.at.localeCompare(a.at) || a.seq - b.seq)
    .map(({ date, text, by }) => ({ date, text, by }));
}

/** 执行者页：档案（信任、观察）与交付记录。既没交付过也没有模型或组合档案的，当不存在。 */
export async function mapWorker(db: DatabaseSync, id: string) {
  parseWorker(id);
  const resolved = await resolveWorker(id, db);
  const report = hasTable(db, "task_deliveries")
    ? await workerReport(db, id)
    : null;
  const profile = resolved.profile;
  const records = report?.deliveries ?? [];
  if (!records.length && !profile.layers.some((l) => l.layer !== "harness"))
    throw new Problem(
      404,
      `执行者 ${id} 没有交付记录，也没有档案`,
      "not_found",
    );
  return {
    worker: resolved.id,
    trust: profile.rules.trust ?? "unknown",
    stats: report?.stats ?? [],
    deliveries: records.slice(0, 200).map((d) => ({
      task: d.task_ref,
      title: d.task_title,
      role: d.job_ref
        ? { ref: d.job_ref, name: d.job_name ?? d.job_ref }
        : null,
      result: deliveryResult(d),
      duration_ms: d.duration_ms,
      story: deliveryStory(d),
    })),
    notes: profileNotes(profile.layers),
    suggestions: (report?.suggestions ?? []).map(adviceView),
  };
}
