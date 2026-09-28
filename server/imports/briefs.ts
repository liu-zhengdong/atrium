import type { DatabaseSync } from "node:sqlite";
import {
  BRIEF_MAX_BYTES,
  briefBytes,
  briefFile,
  clipBrief,
} from "../tasks/brief.ts";
import { readFileSync } from "node:fs";
import { importMark, markImported } from "./marks.ts";

/**
 * 旧任务的详述回填（#355）：账本以前只存 brief_path，启动时按路径读入 tasks.brief。读不到的记日志、保留路径，其余照常；
 * 整轮做完记号，之后不再读这些文件。
 */

const PAGE = 200;

export type BriefRead =
  { ok: true; text: string; clipped: boolean } | { ok: false; reason: string };

/** 按来源路径读一份旧详述；超限截断并注明（不丢内容更要紧）。 */
export function readLegacyBrief(
  path: string,
  repo: string | null,
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
): BriefRead {
  const file = briefFile(path, repo);
  if (!file) return { ok: false, reason: "相对路径但任务没有仓库" };
  let text: string;
  try {
    text = read(file).replace(/^﻿/, "");
  } catch (error) {
    return {
      ok: false,
      reason: `读不到 ${file}（${(error as NodeJS.ErrnoException).code ?? "错误"}）`,
    };
  }
  const clipped = briefBytes(text) > BRIEF_MAX_BYTES;
  return { ok: true, text: clipped ? clipBrief(text) : text, clipped };
}

export type BackfillResult = { filled: number; missing: number };

export function backfillBriefs(
  db: DatabaseSync,
  log: (line: string) => void = console.error,
  read?: (file: string) => string,
): BackfillResult | null {
  if (importMark(db, "task_briefs")) return null;
  const result = { filled: 0, missing: 0 };
  let after = 0;
  for (;;) {
    const rows = db
      .prepare(
        "SELECT id,brief_path,repo FROM tasks WHERE id>? AND brief IS NULL AND brief_path IS NOT NULL ORDER BY id LIMIT ?",
      )
      .all(after, PAGE) as {
      id: number;
      brief_path: string;
      repo: string | null;
    }[];
    if (!rows.length) break;
    for (const row of rows) {
      after = row.id;
      const found = readLegacyBrief(row.brief_path, row.repo, read);
      if (!found.ok) {
        result.missing++;
        log(`任务详述回填：t${row.id} ${found.reason}，保留原路径`);
        continue;
      }
      db.prepare("UPDATE tasks SET brief=? WHERE id=? AND brief IS NULL").run(
        found.text,
        row.id,
      );
      result.filled++;
      if (found.clipped)
        log(
          `任务详述回填：t${row.id} 超过 ${BRIEF_MAX_BYTES / 1024} KB，已截断`,
        );
    }
  }
  markImported(
    db,
    "task_briefs",
    `回填 ${result.filled} 份，读不到 ${result.missing} 份`,
  );
  if (result.filled || result.missing)
    log(
      `任务详述已进库：回填 ${result.filled} 份${result.missing ? `，${result.missing} 份读不到（保留原路径，atrium task set tN --brief 文件 补上）` : ""}`,
    );
  return result;
}
