import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { chainIds } from "../org/aspects.ts";
import { all, nodeByAddress, ref } from "../org/model.ts";
import { hasOrg } from "../org/task-node.ts";
import { listJobRoles, type JobRole } from "./job-roles.ts";
import { alsoOf, involvedOf } from "./also.ts";

/**
 * 专员归属与可选范围（#373）：专员有的全组织共用（part 为空），有的属于某个部分（安全专员属于安全）。
 * 一个任务可选的专员 = 归属链上各层的 + 牵涉部分的（显式 --also 与自动牵涉）+ 全组织的。
 * `--by`、`--ask` 校验、`task pick` 与 `specialist ls --part` 都按这个范围；判定 `scopeOf` 是纯函数。
 */

/** own：就属于这一部分；chain：属于上级；also：属于牵涉的部分；org：全组织共用。 */
export type SpecialistScope = "own" | "chain" | "also" | "org";

export type ScopeInput = {
  /** 归属部分；没有为 null。 */
  part: number | null;
  /** 根 → 归属部分（含）。 */
  chain: readonly number[];
  /** 牵涉的部分（显式与自动）。 */
  involved: readonly number[];
};

/** 纯函数：一位专员落在哪一档；不在范围为 null。 */
export function scopeOf(
  partId: number | null,
  input: ScopeInput,
): SpecialistScope | null {
  if (partId === null) return "org";
  if (partId === input.part) return "own";
  if (input.chain.includes(partId)) return "chain";
  if (input.involved.includes(partId)) return "also";
  return null;
}

const ORDER: SpecialistScope[] = ["own", "chain", "also", "org"];

export type ScopedSpecialist = JobRole & { scope: SpecialistScope };

/** 纯函数：可选的专员，本部分的在前，其次上级、牵涉部分、全组织。 */
export function inScope(
  roles: readonly JobRole[],
  input: ScopeInput,
): ScopedSpecialist[] {
  return roles
    .flatMap((role) => {
      const scope = scopeOf(role.part_id, input);
      return scope ? [{ ...role, scope }] : [];
    })
    .sort(
      (a, b) => ORDER.indexOf(a.scope) - ORDER.indexOf(b.scope) || a.id - b.id,
    );
}

function chainOf(db: DatabaseSync, part: number | null): number[] {
  if (part === null || !hasOrg(db)) return [];
  return chainIds(
    all<{ id: number; parent_id: number | null }>(
      db,
      "SELECT id,parent_id FROM org_nodes ORDER BY id LIMIT 501",
    ),
    part,
  );
}

/** 读库：某个部分（及显式牵涉的部分）可选的专员。 */
export function scopeInput(
  db: DatabaseSync,
  part: number | null,
  involved: readonly number[],
): ScopeInput {
  return { part, chain: chainOf(db, part), involved };
}

/** `specialist ls --part oN`：这一部分可选的专员（含自动牵涉的管方面部分的）。 */
export function specialistsForPart(db: DatabaseSync, address: string) {
  const node = nodeByAddress(db, address);
  const { auto } = involvedOf(db, { id: 0, part_id: node.id, node_id: null });
  return {
    part: ref(node.id),
    name: node.name,
    specialists: inScope(listJobRoles(db), scopeInput(db, node.id, auto)),
  };
}

/** 一个任务（改完后的样子）可选的专员。 */
export function specialistsForTask(
  db: DatabaseSync,
  task: { part: number | null; also: readonly number[] },
) {
  const { auto } = involvedOf(db, { id: 0, part_id: task.part, node_id: null });
  const input = scopeInput(db, task.part, [...task.also, ...auto]);
  return { input, specialists: inScope(listJobRoles(db), input) };
}

const names = (list: readonly { name: string }[]) =>
  list.map((s) => s.name).join("、") || "（无）";

/**
 * 校验 `--by` 与 `--ask` 请的专员都在任务范围里（专员 id 为正数）；不在就给人话报错与可选名单。
 * flag 是用户写的参数名。
 */
export function checkSpecialists(
  db: DatabaseSync,
  task: { part: number | null; also: readonly number[] },
  picks: { flag: string; ids: readonly number[] }[],
) {
  const wanted = picks.filter((p) => p.ids.length);
  if (!wanted.length) return;
  const { specialists } = specialistsForTask(db, task);
  const allowed = new Set(specialists.map((s) => s.id));
  const roles = listJobRoles(db);
  for (const { flag, ids } of wanted)
    for (const id of ids) {
      if (allowed.has(id)) continue;
      const role = roles.find((r) => r.id === id);
      if (!role) continue;
      const where =
        task.part === null
          ? "本任务没有归属部分"
          : `本任务归属 ${ref(task.part)}`;
      throw new Problem(
        400,
        `${flag}: ${role.name}（${role.ref}）属于「${role.part_name ?? role.part}」（${role.part}），${where}，请不到它；可选：${names(specialists)}；确实要它一起看，加 --also ${role.part}`,
        "usage",
        undefined,
        task.part === null
          ? "atrium specialist ls"
          : `atrium specialist ls --part ${ref(task.part)}`,
      );
    }
}

export type PickSpecialists = {
  available: {
    ref: string;
    name: string;
    scope: SpecialistScope;
    part: string | null;
    part_name: string | null;
  }[];
  /** 干活的专员不在范围里（改了归属后留下的）时的人话；在范围里为 null。 */
  job_outside: string | null;
};

/** `task pick`：本任务能请的专员，以及干活的专员还在不在范围里。 */
export function pickSpecialists(
  db: DatabaseSync,
  task: {
    id: number;
    part_id: number | null;
    node_id: number | null;
    job_id: number | null;
  },
): PickSpecialists {
  const part = task.part_id ?? task.node_id;
  const { specialists } = specialistsForTask(db, {
    part,
    also: alsoOf(db, task.id),
  });
  const job =
    task.job_id && !specialists.some((s) => s.id === task.job_id)
      ? listJobRoles(db).find((r) => r.id === task.job_id)
      : undefined;
  return {
    available: specialists.map((s) => ({
      ref: s.ref,
      name: s.name,
      scope: s.scope,
      part: s.part,
      part_name: s.part_name,
    })),
    job_outside: job
      ? `干活的专员 ${job.name}（${job.ref}）属于「${job.part_name ?? job.part}」，不在本任务范围：加 --also ${job.part} 或换 --by`
      : null,
  };
}
