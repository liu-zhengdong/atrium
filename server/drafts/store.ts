import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { nodeByAddress, one, ref, transaction } from "../org/model.ts";
import { charterFields } from "../org/write.ts";
import { editMap } from "../map/write.ts";
import { taskDir } from "../tasks/active.ts";
import { clipBrief } from "../tasks/brief.ts";
import { createTask, getTask, type Task } from "../tasks/ledger.ts";
import { parseTaskRef, taskRef } from "../tasks/ledger-model.ts";
import {
  changesOf,
  DRAFT_FILE,
  DRAFT_FILE_MAX,
  draftBrief,
  fieldsOf,
  parseDraft,
  type Change,
  type Draft,
  type Materials,
} from "./plan.ts";

/**
 * 全景初稿的账（t186）：`overview_drafts` 一件起草任务一行，记仓库、要写到哪个节点、
 * 任务完成时读到的初稿或错误、写没写进组织树。旧运行时没有同名表。
 * 初稿只在用户确认（`map apply`）后才写进节点的人话字段；组成部分不写字段，留给建节点。
 */
export function ensureDraftTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS overview_drafts (
    task_id INTEGER PRIMARY KEY, repo TEXT NOT NULL, node_id INTEGER,
    draft TEXT, error TEXT, settled_at INTEGER,
    applied_at INTEGER, applied_node INTEGER, applied_by TEXT,
    created_at INTEGER NOT NULL)`);
  ready.add(db);
}

const ready = new WeakSet<DatabaseSync>();
/** 表在不在（任务运行时单测不建这张表）；建过就记住。 */
function hasDrafts(db: DatabaseSync) {
  if (ready.has(db)) return true;
  const ok = !!one(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='overview_drafts'",
  );
  if (ok) ready.add(db);
  return ok;
}

type DraftRow = {
  task_id: number;
  repo: string;
  node_id: number | null;
  draft: string | null;
  error: string | null;
  settled_at: number | null;
  applied_at: number | null;
  applied_node: number | null;
  applied_by: string | null;
  created_at: number;
};

const rowOf = (db: DatabaseSync, taskId: number) =>
  one<DraftRow>(db, "SELECT * FROM overview_drafts WHERE task_id=?", taskId);

/** 这件任务是不是全景初稿的起草任务。 */
export function isDraftTask(db: DatabaseSync, taskId: number) {
  return hasDrafts(db) && !!rowOf(db, taskId);
}

const usage = (message: string, next?: string) =>
  new Problem(400, message, "usage", undefined, next);

/** 起草请求：仓库路径（绝对）、可选的目标节点与执行者。 */
export function draftInput(raw: unknown): {
  repo: unknown;
  node: string | null;
  worker: string | undefined;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw usage("请求体应为 JSON 对象");
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body))
    if (!["repo", "node", "worker"].includes(key))
      throw usage(`${key}: 是未知字段`);
  const optional = (key: string, flag: string) => {
    const value = body[key];
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !value.trim())
      throw usage(`${flag}: 应为文本`);
    return value.trim();
  };
  return {
    repo: body.repo,
    node: optional("node", "--node"),
    worker: optional("worker", "--worker") ?? undefined,
  };
}

/** 建起草任务（不交 PR、不建 worktree，执行者在任务目录里干活、只读仓库）并登记。 */
export function createDraftTask(
  db: DatabaseSync,
  materials: Materials,
  node: string | null,
  now = Date.now(),
): Task {
  ensureDraftTables(db);
  const target = node === null ? null : nodeByAddress(db, node);
  if (target && target.archived_at !== null)
    throw new Problem(409, `${ref(target.id)} 已归档`, "conflict");
  if (target?.kind === "concern")
    throw usage(
      `--node: ${ref(target.id)} ${target.name} 是专员（关注点），不在全景图的部分里`,
    );
  return transaction(db, () => {
    const task = createTask(
      db,
      {
        title: `起草全景初稿：${materials.name}`,
        brief: clipBrief(draftBrief(materials)),
        deliver: "none",
        ...(target ? { part: ref(target.id) } : {}),
      },
      now,
    );
    db.prepare(
      "INSERT INTO overview_drafts(task_id,repo,node_id,created_at) VALUES (?,?,?,?)",
    ).run(task.id, materials.repo, target?.id ?? null, now);
    return task;
  });
}

/** 执行者写初稿的位置（没有仓库的任务在任务目录的 work 下干活）。 */
export const draftFileOf = (data: string, taskId: number) =>
  join(taskDir(data, taskId), "work", DRAFT_FILE);

function readDraftFile(file: string): string | null | { error: string } {
  try {
    if (statSync(file).size > DRAFT_FILE_MAX)
      return { error: `${DRAFT_FILE} 超过 ${DRAFT_FILE_MAX / 1024} KB` };
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export type SettleResult =
  | { draft: "ready"; next: string }
  | { draft_error: string; draft_file: string; next: string };

/**
 * 起草任务完成（done）时读工作目录里的初稿，校验后存进账里；读不到或不合格不挡任务完成，
 * 错误随完成事件交给派活的人。不是起草任务返回 undefined；已读到过初稿的不再读。
 */
export function settleDraft(
  db: DatabaseSync,
  data: string,
  taskId: number,
  now = Date.now(),
): SettleResult | undefined {
  if (!hasDrafts(db)) return undefined;
  const row = rowOf(db, taskId);
  if (!row) return undefined;
  const task = taskRef(taskId);
  const ready = {
    draft: "ready" as const,
    next: `atrium map apply ${task} --dry-run`,
  };
  if (row.draft !== null) return ready;
  const file = draftFileOf(data, taskId);
  const raw = readDraftFile(file);
  const parsed =
    raw !== null && typeof raw === "object"
      ? { ok: false as const, error: raw.error }
      : parseDraft(raw);
  if (!parsed.ok) {
    db.prepare(
      "UPDATE overview_drafts SET error=?,settled_at=? WHERE task_id=?",
    ).run(parsed.error, now, taskId);
    return {
      draft_error: parsed.error,
      draft_file: file,
      next: `重新起草：atrium map draft ${row.repo}${row.node_id === null ? "" : ` --node ${ref(row.node_id)}`}`,
    };
  }
  db.prepare(
    "UPDATE overview_drafts SET draft=?,error=NULL,settled_at=? WHERE task_id=?",
  ).run(JSON.stringify(parsed.draft), now, taskId);
  return ready;
}

export type DraftView = {
  task: string;
  repo: string;
  status: "drafting" | "failed" | "ready" | "applied";
  draft: Draft | null;
  error: string | null;
  /** 写到哪个节点（起草时给的，或 apply 时给的）。 */
  node: string | null;
  node_name: string | null;
  /** 写进节点会改哪些字段；没有节点时为 null。 */
  changes: Change[] | null;
  applied_at: number | null;
  applied_by: string | null;
  dry_run: boolean;
};

/**
 * 看初稿（--dry-run）或确认写进节点：只写人话字段（alias、analogy、what、uses、flow），
 * 没给的字段不动；组成部分不写，留给建节点。同一份初稿只写一次。权限与校验走 map edit。
 */
export function applyDraft(
  db: DatabaseSync,
  reference: string,
  raw: unknown,
  actor: string,
  now = Date.now(),
): DraftView {
  ensureDraftTables(db);
  if (
    raw !== undefined &&
    raw !== null &&
    (typeof raw !== "object" || Array.isArray(raw))
  )
    throw usage("请求体应为 JSON 对象");
  const body = (raw ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(body))
    if (!["node", "dry_run"].includes(key)) throw usage(`${key}: 是未知字段`);
  if (body.node !== undefined && typeof body.node !== "string")
    throw usage("--node: 应为节点，如 o5");
  const dryRun = body.dry_run === true;
  const id = parseTaskRef(reference, "任务");
  const row = rowOf(db, id);
  const task = taskRef(id);
  if (!row)
    throw new Problem(404, `${task} 不是全景初稿的起草任务`, "not_found");
  const nodeArg =
    typeof body.node === "string" && body.node.trim() ? body.node.trim() : null;
  const target =
    nodeArg !== null
      ? nodeByAddress(db, nodeArg)
      : row.applied_node !== null
        ? nodeByAddress(db, ref(row.applied_node))
        : row.node_id !== null
          ? nodeByAddress(db, ref(row.node_id))
          : null;
  const draft = row.draft === null ? null : (JSON.parse(row.draft) as Draft);
  const status: DraftView["status"] =
    row.applied_at !== null
      ? "applied"
      : draft
        ? "ready"
        : row.error !== null
          ? "failed"
          : "drafting";
  const view = (changes: Change[] | null, applied = row): DraftView => ({
    task,
    repo: row.repo,
    status: applied.applied_at !== null ? "applied" : status,
    draft,
    error: row.error,
    node: target ? ref(target.id) : null,
    node_name: target?.name ?? null,
    changes,
    applied_at: applied.applied_at,
    applied_by: applied.applied_by,
    dry_run: dryRun,
  });
  const changes =
    draft && target ? changesOf(charterFields(db, target.id), draft) : null;
  if (dryRun) return view(changes);
  if (!draft) {
    const state = getTask(db, task).status;
    throw new Problem(
      409,
      row.error
        ? `${task} 没有可用的初稿：${row.error}`
        : `${task} 的初稿还没好（任务${state === "running" ? "在跑" : `状态 ${state}`}）`,
      "conflict",
      undefined,
      row.error
        ? `atrium map draft ${row.repo}${row.node_id === null ? "" : ` --node ${ref(row.node_id)}`}`
        : `atrium task wait ${task}`,
    );
  }
  if (row.applied_at !== null)
    throw new Problem(
      409,
      `${task} 的初稿已写进 ${ref(row.applied_node!)}，不再重复写；要改用 atrium map edit`,
      "conflict",
      undefined,
      `atrium map ${ref(row.applied_node!)}`,
    );
  if (!target)
    throw usage(
      `--node: 必填——写到哪个节点；这一块还没建就先建：atrium map add 父节点 ${draft.name ?? "名称"}`,
    );
  if (target.archived_at !== null)
    throw new Problem(409, `${ref(target.id)} 已归档`, "conflict");
  if (target.kind === "concern")
    throw usage(
      `--node: ${ref(target.id)} ${target.name} 是专员（关注点），不在全景图的部分里`,
    );
  transaction(db, () => {
    if (changes!.length)
      editMap(
        db,
        ref(target.id),
        Object.fromEntries(changes!.map((c) => [c.field, c.after])),
        actor,
      );
    db.prepare(
      "UPDATE overview_drafts SET applied_at=?,applied_node=?,applied_by=? WHERE task_id=?",
    ).run(now, target.id, actor, id);
  });
  return view(changes, rowOf(db, id)!);
}
