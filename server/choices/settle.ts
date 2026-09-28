import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { one, ref } from "../org/model.ts";
import { partRoute } from "../leaders/subscriber.ts";
import { researchRound } from "../schedules/model.ts";
import { taskDir } from "../tasks/dispatch/active.ts";
import type { EventInbox } from "../tasks/events/events.ts";
import { addChoice, ensureChoiceTables } from "./store.ts";
import { announceChoice } from "./notify.ts";
import { choiceRef } from "./model.ts";

/**
 * 调研类周期任务的收尾：任务完成（done）时，工作目录里有 choice.json 就登记成挂在本部门上的选项单
 * （提的人记这个部门的 leader，出自这件任务），叫醒秘书。没写文件的调研照常完成；写了但不合格不挡完成，
 * 错误写进完成事件交负责人补。同一件任务只登记一次。调研执行者没有 Atrium 的访问，只能写文件。
 */

const CHOICE_FILE = "choice.json";
const CHOICE_FILE_MAX = 64 * 1024;

/** 研究者写选项单的位置（调研任务没有仓库，在任务目录的 work 下干活）。 */
export const choiceFileOf = (data: string, taskId: number) =>
  join(taskDir(data, taskId), "work", CHOICE_FILE);

/** 文件内容 → 选项单对象（纯函数）；字段校验留给 addChoice。 */
function parseChoiceFile(
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = raw.replace(/^﻿/, "").trim();
  if (!text) return { ok: false, error: `${CHOICE_FILE} 是空的` };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: `${CHOICE_FILE} 不是合法的 JSON` };
  }
}

/** 读选项单文件：没有为 null；太大给错误，不读进内存。 */
function readFile(file: string): string | null | { error: string } {
  try {
    if (statSync(file).size > CHOICE_FILE_MAX)
      return { error: `${CHOICE_FILE} 超过 ${CHOICE_FILE_MAX / 1024} KB` };
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export type RoundResult =
  | { choice: string; next: string }
  | { choice_error: string; choice_file: string; next: string };

/** 不是调研任务、或没写选项单返回 undefined；写了就登记，结果并进任务完成事件。 */
export function settleRound(
  db: DatabaseSync,
  inbox: EventInbox,
  data: string,
  taskId: number,
): RoundResult | undefined {
  const round = researchRound(db, taskId);
  if (!round) return undefined;
  const file = choiceFileOf(data, taskId);
  const raw = readFile(file);
  if (raw === null) return undefined;
  ensureChoiceTables(db);
  const already = one<{ id: number }>(
    db,
    "SELECT id FROM choices WHERE task_id=? LIMIT 1",
    taskId,
  );
  if (already)
    return {
      choice: choiceRef(already.id),
      next: `atrium choice show ${choiceRef(already.id)}`,
    };
  const fix = `修好后：atrium choice add ${ref(round.node_id)} --file ${file} --task t${taskId}`;
  const parsed =
    typeof raw === "object"
      ? { ok: false as const, error: raw.error }
      : parseChoiceFile(raw);
  if (!parsed.ok)
    return { choice_error: parsed.error, choice_file: file, next: fix };
  const route = partRoute(db, round.node_id);
  const creator =
    route.subscriber === "secretary" ? undefined : route.subscriber;
  try {
    const choice = addChoice(
      db,
      { node: ref(round.node_id), task: `t${taskId}`, choice: parsed.value },
      route.subscriber,
    );
    announceChoice(db, inbox, choice, creator);
    return { choice: choice.ref, next: `atrium choice show ${choice.ref}` };
  } catch (error) {
    // 登记不上不挡任务完成：校验错误原样给负责人，意外错误另记日志。
    if (!(error instanceof Problem))
      console.error(`调研 t${taskId} 登记选项单失败：`, error);
    return {
      choice_error: error instanceof Error ? error.message : String(error),
      choice_file: file,
      next: fix,
    };
  }
}
