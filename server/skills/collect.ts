import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { LIMITS, sameFiles, skillMeta, validateFiles } from "./model.ts";
import { NOTES, readManifest, readMounted } from "./mount.ts";
import {
  filesAt,
  ownerOf,
  proposalRef,
  recordProposal,
  type Owner,
} from "./store.ts";

/**
 * 收尾回收（#264 第 3b 步）：比对挂载副本与挂载时的修订，有差异就在任务上生成「技能修订提议」。
 * 一次性执行者不直接改技能本体：多个任务可能并用同一技能，改动也未必对，须经 owner 节点的 leader 审核。
 */

export type Collected = {
  proposal: string;
  slug: string;
  base: string;
  owner: Owner;
};

function notes(dir: string): string {
  try {
    const text = readFileSync(join(dir, NOTES), "utf8").trim();
    return Array.from(text).slice(0, LIMITS.proposalReason).join("");
  } catch {
    return "";
  }
}

export function collectSkillEdits(
  db: DatabaseSync,
  taskId: number,
  dir: string,
): { proposals: Collected[]; problems: string[] } {
  const manifest = readManifest(dir);
  const proposals: Collected[] = [];
  const problems: string[] = [];
  if (!manifest) return { proposals, problems };
  const reason = notes(dir) || "执行者没写原因（见任务结果）";
  for (const entry of manifest.skills) {
    const base = filesAt(db, entry.id, entry.rev);
    if (!base) continue;
    const read = readMounted(entry.dir);
    if ("problem" in read) {
      problems.push(`${entry.slug}：${read.problem}，没生成提议`);
      continue;
    }
    if (sameFiles(read.files, base)) continue;
    try {
      const files = validateFiles(read.files);
      skillMeta(entry.slug, files);
      const { id, created } = recordProposal(db, {
        skillId: entry.id,
        taskId,
        baseRev: entry.rev,
        files,
        reason,
      });
      if (created)
        proposals.push({
          proposal: proposalRef(id),
          slug: entry.slug,
          base: `r${entry.rev}`,
          owner: ownerOf(db, entry.id),
        });
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      problems.push(
        `${entry.slug}：改动不合规（${error.message}），没生成提议`,
      );
    }
  }
  return { proposals, problems };
}
