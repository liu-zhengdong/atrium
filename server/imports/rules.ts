import type { DatabaseSync } from "node:sqlite";
import { all, one } from "../org/model.ts";
import { POINT_LIMITS } from "../org/points.ts";
import { importMark, markImported } from "./marks.ts";
import { updateTask } from "../tasks/ledger.ts";
import { dequeue } from "../tasks/queue.ts";

/**
 * 规矩并进要点（一次性迁移）：此前规矩散在硬边界、原则决定、章程、管方面的部门、产品部里；
 * 这里只在建新结构那一次读旧数据，折算完记号，之后旧表旧列不读不写。
 * - 硬边界：文字条目迁成所在节点（根）的要点，排在最前；带数值的两项（给用户留的额度、花费上限）进根节点配置。
 * - 原则决定（没被推翻、没沉淀过的）：迁成要点，挂在它第一个关联的节点上，没关联挂根；和链上已有要点开头相同的跳过。
 * - 管方面的部门：它的要点挪到适用范围的共同上级（缺省是它的上级），部门本身成为普通部门。
 * - 产品部：节点归档，它的周期调研改挂到它管的那一块，没写详述的补上调研详述。
 * - 章程字段：目标并进「是什么」（「是什么」已写就不动），汇报、上交、目标字段删掉（通用规则在 leader 与秘书的提示词里）。
 * - 上线验证（端到端验证挪到合入前）：还没出结论的验证任务撤出队列、取消，不再派人去真实环境跑。
 * 单条出错记日志跳过，其余照常；整轮做完才记号。
 */

const MARK = "rules_into_points";

/** 调研类周期任务的详述：产品部下线后补给原来的调研（选项单格式见 atrium choice add --help）。 */
export const RESEARCH_BRIEF = [
  "这一轮的活：看清这一块现在的样子（可以读仓库与 gh 上的 issue、PR）和外面同类产品的动向，提一份选项单交用户拍板——3 到 5 个大方向；顺手看到的一天内能做完、不改用法的小改进写进 small，交这一块的 leader 自己定。",
  "只调研和提选项：不写代码、不改仓库、不开 PR、不建任务，不读凭据。",
  '在当前工作目录写 choice.json，格式照 `atrium choice add --help` 里的说明（title、options 每个 title/gain/why_now/cost/skip/basis、recommend、why、可选 small）；写完用 node -e \'JSON.parse(require("fs").readFileSync("choice.json","utf8"))\' 自查一次。任务结束时运行时会把它登记成挂在这一块上的选项单。',
  "最后的回复用几行说清楚提了哪几个选项、推荐哪个、为什么。",
].join("\n\n");

const hasTable = (db: DatabaseSync, name: string) =>
  !!one(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?",
    name,
  );
const hasColumn = (db: DatabaseSync, table: string, column: string) =>
  all<{ name: string }>(db, `PRAGMA table_info(${table})`).some(
    (c) => c.name === column,
  );
const clip = (text: string, max: number) =>
  Array.from(text).length > max
    ? `${Array.from(text)
        .slice(0, max - 1)
        .join("")}…`
    : text;
/** 去掉标点空白后的开头（判重用，纯函数）。 */
export const headOf = (text: string) =>
  Array.from(text.replace(/[\s\p{P}]/gu, ""))
    .slice(0, 12)
    .join("");

type Node = { id: number; parent_id: number | null };

/** 从根到 id 的节点（含 id）。纯函数。 */
export function chainOf(list: readonly Node[], id: number): number[] {
  const out: number[] = [];
  for (
    let current = list.find((n) => n.id === id);
    current && !out.includes(current.id);
    current = list.find((n) => n.id === current!.parent_id)
  )
    out.unshift(current.id);
  return out;
}

/** 几个节点的最近共同上级（含自身）；找不到退回根。纯函数。 */
export function commonAncestor(list: readonly Node[], ids: readonly number[]) {
  const chains = ids.map((id) => chainOf(list, id)).filter((c) => c.length);
  const root = list.find((n) => n.parent_id === null)?.id ?? ids[0] ?? 0;
  if (!chains.length) return root;
  let common = chains[0]!;
  for (const chain of chains.slice(1))
    common = common.filter((id, i) => chain[i] === id);
  return common.at(-1) ?? root;
}

const parseIds = (value: string | null | undefined): number[] | null => {
  if (!value) return null;
  try {
    const list = JSON.parse(value) as unknown;
    if (!Array.isArray(list)) return null;
    const ids = list.filter(
      (x): x is number => Number.isSafeInteger(x) && (x as number) > 0,
    );
    return ids.length ? ids : null;
  } catch {
    return null;
  }
};

export function migrateRules(
  db: DatabaseSync,
  log: (line: string) => void = console.error,
  now = Date.now(),
) {
  if (importMark(db, MARK) || !hasTable(db, "org_nodes")) return;
  const list = all<Node & { archived_at: number | null }>(
    db,
    "SELECT id,parent_id,archived_at FROM org_nodes ORDER BY id LIMIT 501",
  );
  const root = list.find((n) => n.parent_id === null);
  const step = (name: string, run: () => void) => {
    try {
      run();
    } catch (error) {
      log(
        `规矩迁移（${name}）跳过：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const pointsOf = (node: number) =>
    all<{ id: number; text: string }>(
      db,
      "SELECT id,text FROM org_points WHERE node_id=? ORDER BY pos,id LIMIT 100",
      node,
    );
  const seen = (node: number, text: string) =>
    chainOf(list, node).some((id) =>
      pointsOf(id).some((p) => headOf(p.text) === headOf(text)),
    );
  const insert = db.prepare(
    "INSERT INTO org_points(node_id,pos,text,why,decided_by,check_ref,updated_by,updated_at) VALUES(?,?,?,?,?,NULL,'迁移',?)",
  );
  const update = db.prepare("UPDATE org_points SET pos=? WHERE id=?");
  const renumber = (ids: number[]) =>
    ids.forEach((id, i) => update.run(i + 1, id));
  const counts = {
    boundaries: 0,
    limits: 0,
    principles: 0,
    moved: 0,
    verifies: 0,
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    // 硬边界 → 要点（排在所在节点最前）与根节点配置。
    if (hasTable(db, "org_boundaries")) {
      const rows = all<{
        node_id: number;
        bid: string;
        summary: string;
        detail: string | null;
        param_key: string | null;
        param_value: number | null;
      }>(
        db,
        "SELECT node_id,bid,summary,detail,param_key,param_value FROM org_boundaries ORDER BY node_id,pos LIMIT 20000",
      );
      const byNode = new Map<number, typeof rows>();
      for (const row of rows)
        byNode.set(row.node_id, [...(byNode.get(row.node_id) ?? []), row]);
      for (const [node, entries] of byNode)
        step(`o${node} 的硬边界`, () => {
          const before = pointsOf(node).map((p) => p.id);
          const added: number[] = [];
          for (const e of entries)
            if (e.param_key === null && e.summary.trim()) {
              if (seen(node, e.summary)) continue;
              added.push(
                Number(
                  insert.run(
                    node,
                    0,
                    clip(e.summary.trim(), POINT_LIMITS.text),
                    clip(e.detail?.trim() || "底线", POINT_LIMITS.why),
                    "原硬边界",
                    now,
                  ).lastInsertRowid,
                ),
              );
              counts.boundaries++;
            }
          renumber([...added, ...before]);
        });
      // 数值两项：各节点写的取最严（额度留得多、花费上限小）。
      const strictest = (key: string, pick: (a: number, b: number) => number) =>
        rows
          .filter((r) => r.param_key === key && r.param_value !== null)
          .map((r) => r.param_value!)
          .reduce<number | null>((a, b) => (a === null ? b : pick(a, b)), null);
      for (const [key, value] of [
        ["quota_reserve_percent", strictest("quota_reserve_percent", Math.max)],
        ["money_yuan_max", strictest("money_yuan_max", Math.min)],
      ] as const)
        if (value !== null) {
          db.prepare(
            "INSERT OR IGNORE INTO org_limits(key,value,updated_by,updated_at) VALUES(?,?,'迁移',?)",
          ).run(key, value, now);
          counts.limits++;
        }
    }

    // 原则决定 → 要点。
    if (
      hasTable(db, "decisions") &&
      hasColumn(db, "decisions", "principle") &&
      root
    ) {
      const settled = hasColumn(db, "decisions", "settled_point")
        ? " AND settled_point IS NULL"
        : "";
      for (const d of all<{
        id: number;
        decided_on: string;
        decided_by: string;
        text: string;
        why: string;
      }>(
        db,
        `SELECT id,decided_on,decided_by,text,why FROM decisions WHERE principle=1 AND superseded_by IS NULL${settled} ORDER BY decided_on,id LIMIT 200`,
      ))
        step(`d${d.id}`, () => {
          const linked = hasTable(db, "decision_nodes")
            ? one<{ node_id: number }>(
                db,
                "SELECT node_id FROM decision_nodes WHERE decision_id=? ORDER BY node_id LIMIT 1",
                d.id,
              )?.node_id
            : undefined;
          const node =
            linked !== undefined &&
            list.some((n) => n.id === linked && n.archived_at === null)
              ? linked
              : root.id;
          if (seen(node, d.text)) return;
          const order = pointsOf(node).map((p) => p.id);
          // 只写了标题的（如「Atrium 定位」）把原因并进来，要点才看得懂；太长的截断并指回原决定。
          const full =
            Array.from(d.text).length <= 12 ? `${d.text}：${d.why}` : d.text;
          const text =
            Array.from(full).length > POINT_LIMITS.text
              ? `${clip(full, POINT_LIMITS.text - 8)}（全文见 d${d.id}）`
              : full;
          const id = Number(
            insert.run(
              node,
              order.length + 1,
              text,
              full === d.text
                ? clip(d.why, POINT_LIMITS.why)
                : `原则决定 d${d.id}`,
              clip(
                `${d.decided_by === "secretary" ? "秘书" : d.decided_by} ${d.decided_on.slice(5)}`,
                POINT_LIMITS.by,
              ),
              now,
            ).lastInsertRowid,
          );
          renumber([...order, id]);
          counts.principles++;
        });
    }

    // 管方面的部门：要点挪到适用范围的共同上级。
    if (hasColumn(db, "org_nodes", "aspect")) {
      const pointApplies = hasColumn(db, "org_points", "applies");
      for (const aspect of all<{
        id: number;
        parent_id: number | null;
        applies: string | null;
      }>(
        db,
        `SELECT id,parent_id,${hasColumn(db, "org_nodes", "applies") ? "applies" : "NULL AS applies"} FROM org_nodes WHERE aspect=1 AND archived_at IS NULL LIMIT 500`,
      ))
        step(`o${aspect.id} 的要点`, () => {
          for (const p of all<{ id: number; applies: string | null }>(
            db,
            `SELECT id,${pointApplies ? "applies" : "NULL AS applies"} FROM org_points WHERE node_id=? ORDER BY pos,id LIMIT 100`,
            aspect.id,
          )) {
            const scope = parseIds(p.applies) ??
              parseIds(aspect.applies) ?? [aspect.parent_id ?? aspect.id];
            const target = commonAncestor(list, scope);
            if (target === aspect.id) continue;
            const order = pointsOf(target).map((x) => x.id);
            db.prepare("UPDATE org_points SET node_id=? WHERE id=?").run(
              target,
              p.id,
            );
            renumber([...order, p.id]);
            counts.moved++;
          }
        });
    }

    // 产品部：归档，周期调研改挂到它管的那一块。
    if (hasTable(db, "products"))
      for (const p of all<{
        node_id: number;
        parent_id: number;
        schedule_id: number | null;
      }>(
        db,
        "SELECT node_id,parent_id,schedule_id FROM products ORDER BY node_id LIMIT 500",
      ))
        step(`产品部 o${p.node_id}`, () => {
          db.prepare(
            "UPDATE org_nodes SET archived_at=?,updated_at=? WHERE id=? AND archived_at IS NULL",
          ).run(now, now, p.node_id);
          if (p.schedule_id !== null && hasTable(db, "schedules"))
            db.prepare(
              "UPDATE schedules SET node_id=?,brief=COALESCE(brief,?),updated_at=? WHERE id=?",
            ).run(p.parent_id, RESEARCH_BRIEF, now, p.schedule_id);
        });

    // 章程字段：目标并进「是什么」，汇报、上交删掉。
    if (hasTable(db, "org_docs"))
      for (const doc of all<{ node_id: number; fields: string }>(
        db,
        "SELECT node_id,fields FROM org_docs WHERE doc='charter' LIMIT 600",
      ))
        step(`o${doc.node_id} 的字段`, () => {
          const fields = JSON.parse(doc.fields) as Record<string, unknown>;
          const goal =
            typeof fields.goal === "string" ? fields.goal.trim() : "";
          const what =
            typeof fields.what === "string" ? fields.what.trim() : "";
          if (!("goal" in fields || "report" in fields || "escalate" in fields))
            return;
          if (goal && !what) fields.what = clip(goal, 300);
          delete fields.goal;
          delete fields.report;
          delete fields.escalate;
          db.prepare(
            "UPDATE org_docs SET fields=? WHERE node_id=? AND doc='charter'",
          ).run(JSON.stringify(fields), doc.node_id);
        });
    // 上线验证任务：没出结论的撤出队列并取消。
    if (hasTable(db, "task_verifications") && hasTable(db, "tasks"))
      for (const v of all<{ id: number }>(
        db,
        `SELECT t.id FROM task_verifications v JOIN tasks t ON t.id=v.verify_id
          WHERE v.decided_at IS NULL AND t.status NOT IN ('done','failed','cancelled','running') LIMIT 500`,
      ))
        step(`上线验证 t${v.id}`, () => {
          dequeue(db, v.id);
          updateTask(db, `t${v.id}`, { status: "cancelled" }, now);
          counts.verifies++;
        });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  markImported(
    db,
    MARK,
    `硬边界 ${counts.boundaries} 条、配置 ${counts.limits} 项、原则 ${counts.principles} 条迁成要点，管方面的要点挪了 ${counts.moved} 条，取消上线验证任务 ${counts.verifies} 件`,
    now,
  );
}
