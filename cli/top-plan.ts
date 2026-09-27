import { oneLine, pad, width } from "./format.ts";

/**
 * `atrium top` 的排期段（#262）：就绪、依赖链、等待中与因上游卡住的待办，数据来自 `/api/tasks/plan`。
 * 纯函数：给定排期与宽度、行数上限画出若干行；旧版服务没有细节字段时退回 waiting_for 原文。
 */

export type PlanTask = {
  ref: string;
  title: string;
  status: string;
  worker: string | null;
  started_at: number | null;
  parent_ref: string | null;
  owner: string | null;
  auto: number;
  node_ref?: string | null;
  goal_ref?: string | null;
  part_ref?: string | null;
  schedule_state?: string | null;
};
export type PlanUpstream = {
  ref: string;
  title?: string;
  status: string;
  worker: string | null;
  started_at: number | null;
  pr: { number: number; state: string | null; error: string | null } | null;
  /** 旧版服务没有这一项。 */
  release?: "merging" | "waiting" | "online" | "failed" | null;
};
export type PlanEntry = {
  task: PlanTask;
  waiting_for: string[];
  reason: string | null;
  node_path?: string | null;
  open_children?: number;
  upstream?: PlanUpstream[];
  after_pr?: {
    repo: string;
    number: number;
    merged: boolean;
    error: string | null;
  }[];
};
export type PlanGroup = "running" | "ready" | "waiting" | "blocked";
export type PlanView = {
  groups: Record<PlanGroup, PlanEntry[]>;
  next_after: string | null;
};

export type PlanFrame = {
  width: number;
  now: number;
  /** 排期段最多占几行（含标题行）；超出折叠并提示 `atrium task plan`。 */
  maxLines: number;
  /** 宽屏给记账节点、执行者与已满足的条件；窄屏只留最要紧的。 */
  wide: boolean;
};

/** 排期段缺省最多几行。 */
export const PLAN_LINES = 20;

const SYMBOL: Record<PlanGroup, string> = {
  running: "●",
  ready: "○",
  waiting: "◇",
  blocked: "✕",
};
const STATUS: Record<string, string> = {
  todo: "待办",
  running: "在跑",
  blocked: "卡住",
  failed: "失败",
  cancelled: "已取消",
  done: "完成",
};

/** 服务给的原因里状态是 `[failed]` 这样的英文标记，换成中文。 */
const readable = (text: string) =>
  text.replace(
    / \[([a-z]+)\]/g,
    (_, status: string) => ` ${STATUS[status] ?? status}`,
  );

const idOf = (ref: string) => Number(ref.slice(1)) || 0;
const byRef = (a: { ref: string }, b: { ref: string }) =>
  idOf(a.ref) - idOf(b.ref);

function elapsed(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

type Item = PlanEntry & { group: PlanGroup; ref: string };

/** 一个上游条件：没满足给一段说明，满足了返回 null。 */
export function upstreamText(
  dep: PlanUpstream,
  now: number,
  wide: boolean,
): string | null {
  if (dep.status === "running") {
    const took = dep.started_at ? elapsed(now - dep.started_at) : "";
    if (!wide) return `${dep.ref} 在跑${took ? ` ${took}` : ""}`;
    const extra = [dep.worker, took].filter(Boolean).join(" · ");
    return `${dep.ref} 在跑${extra ? `（${extra}）` : ""}`;
  }
  if (dep.status !== "done")
    return `${dep.ref} ${STATUS[dep.status] ?? dep.status}`;
  // 与服务端 upstreamCondition 同一规则：要自动上线的，上线才算满足。
  if (dep.release === "online") return null;
  if (dep.release === "failed") return `${dep.ref} 上线失败`;
  if (dep.release === "waiting") return `${dep.ref} 上线`;
  if (!dep.pr || (dep.pr.state === "merged" && dep.release !== "merging"))
    return null;
  if (dep.pr.state === "closed")
    return `${dep.ref} 的 PR #${dep.pr.number} 已关闭未合入`;
  const note = dep.pr.error
    ? "（查询失败）"
    : dep.pr.state === null
      ? "（尚未查询）"
      : "";
  return `${dep.ref} 的 PR #${dep.pr.number} 合入${note}`;
}

/** 等待中的一行说明：逐项列出没满足的条件，宽屏再补上已满足的。 */
export function waitText(entry: PlanEntry, now: number, wide: boolean) {
  if (!entry.upstream && !entry.after_pr)
    return entry.waiting_for.length
      ? `等 ${readable(entry.waiting_for.join("、"))}`
      : "";
  const open: string[] = [];
  const met: string[] = [];
  for (const dep of entry.upstream ?? []) {
    const text = upstreamText(dep, now, wide);
    if (text) open.push(text);
    else met.push(dep.ref);
  }
  for (const pr of entry.after_pr ?? []) {
    // 窄屏只留仓库名，owner 省掉。
    const ref = `${wide ? pr.repo : pr.repo.split("/").pop()}#${pr.number}`;
    if (pr.merged) met.push(ref);
    else open.push(`${ref} 合入${pr.error ? "（查询失败）" : ""}`);
  }
  const head = open.length ? `等 ${open.join("、")}` : "";
  if (!wide || !met.length) return head;
  return `${head}${head ? "；" : ""}已满足 ${met.join("、")}`;
}

function detail(item: Item, now: number, wide: boolean) {
  const task = item.task;
  const part = task.part_ref ?? task.goal_ref;
  const goal = part ? `${part} · ` : "";
  if (item.group === "running") {
    const took = task.started_at ? elapsed(now - task.started_at) : "";
    return (
      goal +
      (wide
        ? ["在跑", task.worker, took].filter(Boolean).join(" · ")
        : `在跑${took ? ` ${took}` : ""}`)
    );
  }
  // 链里的上游自己跑失败了：它是下游卡住的原因，照实写失败。
  if (item.group === "blocked" && !scheduleBlocked(item))
    return (
      goal +
      (item.task.status === "failed"
        ? `失败${item.reason && item.reason !== "任务失败" ? `：${item.reason}` : ""}`
        : `卡住：${item.reason ?? "任务受阻"}`)
    );
  if (item.group === "blocked")
    return `${goal}卡住：${readable(item.reason ?? "任务受阻")}`;
  if (item.group === "waiting") return goal + waitText(item, now, wide);
  const auto = task.auto ? "自动派" : "手动派";
  const owner = task.owner ?? "secretary";
  return (
    goal +
    (wide
      ? [item.node_path ?? task.node_ref, auto, owner]
          .filter(Boolean)
          .join(" · ")
      : `${task.auto ? "自动" : "手动"} · ${owner}`)
  );
}

/** 上游短号：有细节用细节，旧版服务从 waiting_for 的开头取。 */
const upstreamRefs = (entry: PlanEntry) =>
  entry.upstream
    ? entry.upstream.map((dep) => dep.ref)
    : entry.waiting_for
        .map((text) => /^(t[1-9][0-9]*)\b/.exec(text)?.[1])
        .filter((ref): ref is string => !!ref);

/** 因排期卡住（上游失败、取消或 PR 关闭）；执行失败、关卡不过的已在上面的卡住里。 */
const scheduleBlocked = (item: Item) =>
  item.task.schedule_state === "blocked" ||
  (item.reason ?? "").startsWith("上游 ");

type Line = { text: string; item?: string };

export type PlanLayout = {
  counts: { ready: number; waiting: number; blocked: number };
  lines: string[];
};

/**
 * 画排期段。父任务下还有未结束的子任务时只当分组标题；
 * 待办之间有依赖的归成一条链，按先后缩进，标题行给出最长的那条路径。
 */
export function renderPlan(plan: PlanView, frame: PlanFrame): PlanLayout {
  const all: Item[] = (
    ["running", "ready", "waiting", "blocked"] as PlanGroup[]
  ).flatMap((group) =>
    (plan.groups[group] ?? []).map((entry) => ({
      ...entry,
      group,
      ref: entry.task.ref,
    })),
  );
  const childParents = new Set(
    all.map((item) => item.task.parent_ref).filter(Boolean),
  );
  const parents = new Map(
    all
      .filter(
        (item) =>
          item.group !== "running" &&
          (item.open_children !== undefined
            ? item.open_children > 0
            : childParents.has(item.ref)),
      )
      .map((item) => [item.ref, item]),
  );
  const items = new Map(
    all
      .filter((item) => !parents.has(item.ref))
      .map((item) => [item.ref, item]),
  );
  const ups = new Map<string, string[]>();
  const downs = new Map<string, string[]>();
  for (const item of items.values()) {
    const list = upstreamRefs(item).filter((ref) => items.has(ref));
    ups.set(item.ref, list);
    for (const ref of list)
      downs.set(ref, [...(downs.get(ref) ?? []), item.ref]);
  }
  // 连通的待办归成一条链（在跑的上游也算进去，好看出在等谁）。
  const chainOf = new Map<string, string[]>();
  for (const item of [...items.values()].sort(byRef)) {
    if (chainOf.has(item.ref)) continue;
    const members: string[] = [];
    const stack = [item.ref];
    while (stack.length) {
      const ref = stack.pop()!;
      if (members.includes(ref)) continue;
      members.push(ref);
      stack.push(...(ups.get(ref) ?? []), ...(downs.get(ref) ?? []));
    }
    for (const ref of members) chainOf.set(ref, members);
  }
  const chains = [...new Set(chainOf.values())]
    .filter((members) => members.length > 1)
    .map((members) => members.sort((a, b) => idOf(a) - idOf(b)));
  const inChain = new Set(chains.flat());
  const alone = [...items.values()]
    .filter((item) => !inChain.has(item.ref))
    .sort(byRef);
  const ready = alone.filter((item) => item.group === "ready");
  const waiting = alone.filter((item) => item.group === "waiting");
  const blocked = alone.filter(
    (item) => item.group === "blocked" && scheduleBlocked(item),
  );
  const chained = chains.flat().map((ref) => items.get(ref)!);
  const counts = {
    ready: ready.length + chained.filter((i) => i.group === "ready").length,
    waiting:
      waiting.length + chained.filter((i) => i.group === "waiting").length,
    blocked:
      blocked.length +
      chained.filter((i) => i.group === "blocked" && scheduleBlocked(i)).length,
  };

  // 列宽：前缀（缩进 + 符号 + 短号）对齐，标题最多占剩下的 45%（窄屏 35%），其余给说明。
  const refW = Math.max(3, ...[...items.keys()].map(width));
  const rows: { indent: number; item: Item }[] = [];
  const depthOf = (
    ref: string,
    members: Set<string>,
    seen = new Set<string>(),
  ): number => {
    if (seen.has(ref)) return 0;
    seen.add(ref);
    const list = (ups.get(ref) ?? []).filter((up) => members.has(up));
    return list.length
      ? 1 + Math.max(...list.map((up) => depthOf(up, members, new Set(seen))))
      : 0;
  };

  type Block = { heading?: string; rows: { indent: number; item: Item }[] };
  const section = (label: string, list: Item[], base: number): Block[] => {
    if (!list.length) return [];
    return [{ heading: label, rows: grouped(list, base) }];
  };
  /** 同一分组父任务下的排在一起，前面加一行分组标题。 */
  const grouped = (list: Item[], base: number) => {
    const out: { indent: number; item: Item }[] = [];
    const groups = new Map<string, Item[]>();
    for (const item of list) {
      const key =
        item.task.parent_ref && parents.has(item.task.parent_ref)
          ? item.task.parent_ref
          : "";
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    for (const key of [...groups.keys()].sort((a, b) => idOf(a) - idOf(b))) {
      if (key) out.push({ indent: -base, item: parents.get(key)! });
      for (const item of groups.get(key)!)
        out.push({ indent: base + (key ? 1 : 0), item });
    }
    return out;
  };

  const blocks: Block[] = [...section("就绪", ready, 1)];
  for (const members of chains) {
    const set = new Set(members);
    const depth = new Map(members.map((ref) => [ref, depthOf(ref, set)]));
    // 展示时挂在最深的那个上游下面，保证先后次序；多个上游在说明里逐项列出。
    const holder = (ref: string) =>
      (ups.get(ref) ?? [])
        .filter((up) => set.has(up))
        .sort((a, b) => depth.get(b)! - depth.get(a)! || idOf(a) - idOf(b))[0];
    const kids = new Map<string, string[]>();
    for (const ref of members) {
      const up = holder(ref);
      if (up) kids.set(up, [...(kids.get(up) ?? []), ref]);
    }
    const deepest = [...members].sort(
      (a, b) => depth.get(b)! - depth.get(a)! || idOf(a) - idOf(b),
    )[0]!;
    const path = [deepest];
    for (let up = holder(deepest); up; up = holder(up)) path.unshift(up);
    const more = members.length - path.length;
    const root = items.get(path[0]!)!;
    const group =
      root.task.parent_ref && parents.has(root.task.parent_ref)
        ? parents.get(root.task.parent_ref)!
        : undefined;
    const base = group ? 2 : 1;
    const chainRows: { indent: number; item: Item }[] = [];
    if (group) chainRows.push({ indent: -1, item: group });
    const walk = (ref: string, level: number) => {
      chainRows.push({ indent: base + level, item: items.get(ref)! });
      for (const kid of (kids.get(ref) ?? []).sort((a, b) => idOf(a) - idOf(b)))
        walk(kid, level + 1);
    };
    for (const ref of members.filter((ref) => !holder(ref))) walk(ref, 0);
    blocks.push({
      heading: `依赖链 ${path.join(" → ")}${more > 0 ? `（另有 ${more} 项）` : ""}`,
      rows: chainRows,
    });
  }
  blocks.push(...section("等待中", waiting, 1), ...section("卡住", blocked, 1));
  rows.push(...blocks.flatMap((block) => block.rows));

  const prefixW = Math.max(
    0,
    ...rows
      .filter((row) => row.indent >= 0)
      .map((row) => row.indent * 2 + 2 + refW),
  );
  const room = Math.max(0, frame.width - prefixW - 2);
  const longest = Math.max(
    8,
    ...rows
      .filter((row) => row.indent >= 0)
      .map((row) => width(row.item.task.title)),
  );
  const titleW = Math.min(
    longest,
    Math.max(8, Math.floor(room * (frame.wide ? 0.45 : 0.35))),
  );
  const detailW = frame.width - prefixW - 2 - titleW - 2;

  const header =
    `排期 · 就绪 ${counts.ready} · 等待中 ${counts.waiting} · 卡住 ${counts.blocked}` +
    (plan.next_after ? " · 不止一页" : "");
  const lines: Line[] = [{ text: fit(header, frame.width) }];
  if (!rows.length)
    lines.push({ text: fit("  没有就绪、等待中或卡住的待办", frame.width) });
  for (const block of blocks) {
    if (block.heading)
      lines.push({ text: fit(` ${block.heading}`, frame.width) });
    for (const row of block.rows) {
      if (row.indent < 0) {
        // 分组标题：父任务本身不算待办。
        const indent = "  ".repeat(-row.indent);
        lines.push({
          text: fit(
            `${indent}▸ ${row.item.ref} ${row.item.task.title}${(row.item.task.part_ref ?? row.item.task.goal_ref) ? ` · ${row.item.task.part_ref ?? row.item.task.goal_ref}` : ""}`,
            frame.width,
          ),
        });
        continue;
      }
      const prefix = pad(
        `${"  ".repeat(row.indent)}${SYMBOL[row.item.group]} ${row.item.ref}`,
        prefixW,
      );
      const title = pad(oneLine(row.item.task.title, titleW), titleW);
      const text = detail(row.item, frame.now, frame.wide);
      const tail = detailW >= 6 && text ? `  ${oneLine(text, detailW)}` : "";
      lines.push({
        text: fit(`${prefix}  ${title}${tail}`.trimEnd(), frame.width),
        item: row.item.ref,
      });
    }
  }
  return { counts, lines: fold(lines, frame, !!plan.next_after) };
}

/** 超过行数上限就折叠，最后一行说还有多少条、去哪看全。 */
function fold(lines: Line[], frame: PlanFrame, paged: boolean): string[] {
  const hint = "完整排期：atrium task plan";
  const max = Math.max(2, frame.maxLines);
  if (lines.length <= max)
    return [
      ...lines.map((line) => line.text),
      ...(paged ? [fit(`  …排期不止一页，${hint}`, frame.width)] : []),
    ];
  const shown = lines.slice(0, max - 1);
  const seen = new Set(shown.map((line) => line.item).filter(Boolean));
  const hidden = new Set(
    lines
      .slice(max - 1)
      .map((line) => line.item)
      .filter((item): item is string => !!item && !seen.has(item)),
  ).size;
  return [
    ...shown.map((line) => line.text),
    fit(
      `  …还有 ${hidden} 条${paged ? "（不止一页）" : ""}，${hint}`,
      frame.width,
    ),
  ];
}

/** 按显示宽度截到一行以内；不像 clip 那样压缩空白，缩进与对齐要保住。 */
export function fit(text: string, max: number) {
  if (width(text) <= max) return text;
  let out = "";
  for (const char of text) {
    if (width(out + char) > max - 1) break;
    out += char;
  }
  return `${out}…`;
}
