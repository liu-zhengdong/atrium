import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { one, ref } from "../org/model.ts";
import { addChoice, ensureChoiceTables } from "../choices/store.ts";
import { announceChoice } from "../choices/notify.ts";
import { choiceRef } from "../choices/model.ts";
import { taskDir } from "../tasks/active.ts";
import type { EventInbox } from "../tasks/events.ts";
import { CHOICE_FILE } from "./brief.ts";
import { productRound } from "./model.ts";

/**
 * 产品部研究的收尾：研究任务完成（done）时读它工作目录里的 choice.json，登记成挂在父节点上的选项单
 * （提的人记产品部 leader，出自这件任务），按拍板人叫醒秘书或 leader。读不到或不合格不挡任务完成，
 * 错误写进完成事件交给产品部 leader 补。同一件任务只登记一次。
 */

export const CHOICE_FILE_MAX = 64 * 1024;

/** 研究者写选项单的位置（没有仓库的任务在任务目录的 work 下干活）。 */
export const choiceFileOf = (data: string, taskId: number) =>
  join(taskDir(data, taskId), "work", CHOICE_FILE);

/** 文件内容 → 选项单对象（纯函数）；null 是没写文件。字段校验留给 addChoice。 */
export function parseChoiceFile(
  raw: string | null,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (raw === null)
    return { ok: false, error: `研究者没有在工作目录写 ${CHOICE_FILE}` };
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

/** 不是产品部的研究任务返回 undefined；是就登记选项单，结果并进任务完成事件。 */
export function settleRound(
  db: DatabaseSync,
  inbox: EventInbox,
  data: string,
  taskId: number,
): RoundResult | undefined {
  const product = productRound(db, taskId);
  if (!product) return undefined;
  const file = choiceFileOf(data, taskId);
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
  const fix = `修好后：atrium choice add ${ref(product.parent_id)} --file ${file} --task t${taskId}`;
  const raw = readFile(file);
  const parsed =
    raw !== null && typeof raw === "object"
      ? { ok: false as const, error: raw.error }
      : parseChoiceFile(raw);
  if (!parsed.ok)
    return { choice_error: parsed.error, choice_file: file, next: fix };
  try {
    const choice = addChoice(
      db,
      {
        node: ref(product.parent_id),
        task: `t${taskId}`,
        choice: parsed.value,
      },
      product.leader,
    );
    announceChoice(db, inbox, choice, product.leader);
    return { choice: choice.ref, next: `atrium choice show ${choice.ref}` };
  } catch (error) {
    // 登记不上不挡任务完成：校验错误原样给 leader，意外错误另记日志。
    if (!(error instanceof Problem))
      console.error(`产品部研究 t${taskId} 登记选项单失败：`, error);
    return {
      choice_error: error instanceof Error ? error.message : String(error),
      choice_file: file,
      next: fix,
    };
  }
}
