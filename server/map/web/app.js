// Atrium 全景网页：只读。数据来自与 `atrium map --json` 相同的接口，
// 订阅 /api/map/stream 的失效通知，变了只重取并重画，不整页重载。
// 一页一件东西：面包屑 → 小字类别、大标题、属性行与介绍 → 页签。三类页：
// - 块（组织节点）：#o2/tasks/all。组织根的页签是组成部分／角色／技能／执行者／原则，执行者可按角色筛（#o1/workers/r1）；
// - 角色：#r1/workers，页签是任务／谁做得好／技能；
// - 执行者：#w/claude+opus:high/notes，页签是交付记录／观察。
// 当前页、页签与筛选都写在 hash 里，刷新与前进后退都回到原处。

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const state = {
  root: null,
  now: null,
  /** 看过的页先用旧数据画出来，再换新的，切换时不闪白。键是页（o2、r1、w/…）。 */
  cache: new Map(),
  route: { page: "node", ref: null, tab: "", extra: "" },
  /** 当前页的数据：{ page: "node", node, org? } / { page: "role", role } / { page: "worker", worker }。 */
  data: null,
  /** 页面的整体状态：ok / missing（链接里的东西不存在）/ empty（没有组织树）/ down / expired。 */
  mode: "loading",
  missing: null,
  seq: 0,
  drawn: { crumbs: "", page: "" },
};

// ---- 取数据 ----

class Expired extends Error {}
class Missing extends Error {}
async function get(path) {
  const response = await fetch(`/api/map${path}`, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (response.status === 401) throw new Expired();
  const body = await response.json().catch(() => ({}));
  // 404 不存在、400 链接里的名字不合法：都当「找不到」，给人话提示。
  if (response.status === 404 || response.status === 400)
    throw new Missing(body.error || "");
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

// ---- 地址 ----

/** 各类页的页签（第一个是默认）；组织根与其他块的页签在 nodeTabs 里再挑。 */
const PAGE_TABS = {
  node: ["parts", "concerns", "tasks", "roles", "skills", "workers", "points"],
  role: ["tasks", "workers", "skills"],
  worker: ["deliveries", "notes"],
};
const REF = { node: /^o[1-9]\d{0,8}$/, role: /^r[1-9]\d{0,8}$/ };

function parseRoute() {
  const parts = location.hash.slice(1).split("/");
  const head = parts.shift() ?? "";
  let page = "node";
  let ref = null;
  if (head === "w") {
    page = "worker";
    try {
      ref = decodeURIComponent(parts.shift() ?? "");
    } catch {
      ref = "";
    }
  } else if (REF.role.test(head)) {
    page = "role";
    ref = head;
  } else if (REF.node.test(head)) ref = head;
  const [tab = "", extra = ""] = parts;
  const ok = PAGE_TABS[page].includes(tab);
  return {
    page,
    ref,
    tab: ok ? tab : "",
    extra:
      ok && tab === "tasks" && extra === "all"
        ? "all"
        : ok && tab === "workers" && REF.role.test(extra)
          ? extra
          : "",
  };
}

/** 执行者标识里的 + 与 : 在 hash 里原样保留，只转义 / 等。 */
const workerPath = (id) =>
  encodeURIComponent(id).replace(/%2B/g, "+").replace(/%3A/g, ":");
function href(page, ref, tab = "", extra = "") {
  const base = page === "worker" ? `w/${workerPath(ref)}` : ref;
  const first = PAGE_TABS[page][0];
  const t = tab && (tab !== first || extra) ? `/${tab}` : "";
  return `#${base}${t}${extra ? `/${extra}` : ""}`;
}
const nodeHref = (ref, tab, extra) => href("node", ref, tab, extra);
const roleHref = (ref, tab, extra) => href("role", ref, tab, extra);
const workerHref = (id, tab) => href("worker", id, tab);
const pageKey = (route, rootRef) =>
  route.page === "worker"
    ? `w/${route.ref}`
    : route.page === "role"
      ? route.ref
      : (route.ref ?? rootRef);

// ---- 人话 ----

function duration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "不到 1 分钟";
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}
const day = (at) => {
  const d = new Date(at);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const title = (n) => n.alias || n.name;
const who = (by) => String(by ?? "").replace(/^u1\b/, "你");
const isPathRule = (rule) => /[/*?]|^\./.test(rule);
const percent = (rate) => `${Math.round(rate * 100)}%`;

/** 执行者标识 claude+opus:high → Claude · Opus · high；模型去掉供应商前缀。 */
function workerLabel(id) {
  if (!id) return "";
  const plus = id.indexOf("+");
  let tool = plus < 0 ? id : id.slice(0, plus);
  let rest = plus < 0 ? "" : id.slice(plus + 1);
  let effort = "";
  const colon = (plus < 0 ? tool : rest).lastIndexOf(":");
  if (colon >= 0) {
    if (plus < 0) {
      effort = tool.slice(colon + 1);
      tool = tool.slice(0, colon);
    } else {
      effort = rest.slice(colon + 1);
      rest = rest.slice(0, colon);
    }
  }
  let model = rest.slice(rest.lastIndexOf("/") + 1);
  if (tool === "claude" && /^[a-z]+$/.test(model))
    model = model[0].toUpperCase() + model.slice(1);
  return [tool === "claude" ? "Claude" : tool, model, effort]
    .filter(Boolean)
    .join(" · ");
}

const TRUST = {
  high: ["高", "green"],
  medium: ["中", "blue"],
  low: ["低", "orange"],
  unknown: ["未定", "gray"],
};
const trustChip = (trust) => {
  const [label, tone] = TRUST[trust] ?? TRUST.unknown;
  return chip(label, tone);
};
/** 验收关卡 → 交付要求的说法。 */
const CHECK = {
  pr_exists: "开 PR",
  local_check: "本地检查通过",
  ci: "远端检查通过",
  finished: "提交推送完整",
  file_growth: "文件不过度膨胀",
  claims_verified: "汇报属实",
  screenshot: "附截图",
};
const checkLabel = (c) => CHECK[c] ?? c;

const ICON = {
  part: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>`,
  concern: `<svg class="icon icon-concern" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/></svg>`,
  role: `<svg class="icon icon-role" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>`,
  skill: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z"/><path d="M8 7h6"/></svg>`,
  point: `<svg class="icon icon-point" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/></svg>`,
  advice: `<svg class="icon icon-advice" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>`,
  go: `<svg class="icon icon-go" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`,
};
const chip = (text, tone) =>
  `<span class="chip chip-${tone}">${esc(text)}</span>`;
/** 可点的胶囊：放在不是整行链接的行里（整行链接里不能再套链接）。 */
const chipLink = (text, tone, url) =>
  `<a class="chip chip-${tone} chip-link" href="${esc(url)}">${esc(text)}</a>`;
const none = `<span class="muted">—</span>`;
/** 任务名：编号在前（与状态栏、top、汇报里的 tN 对得上），标题折行时编号不动。 */
const taskName = (ref, title) =>
  `<span class="task-ref">${esc(ref)}</span><span class="task-title">${esc(title)}</span>`;
/**
 * 表格的一格。extra 里的类：name/text/note 窄屏占满一行，none 窄屏隐藏（空格），
 * tagged 窄屏在值前带上列名（数字列单看不知道是什么）。
 */
const cell = (label, body, extra = "") =>
  `<span class="cell${extra}" role="cell" data-label="${esc(label)}">${body}</span>`;
const table = (kind, heads, rows, empty) =>
  `<div class="table table-${kind}" role="table">
    ${heads ? `<div class="row head" role="row">${heads.map((h) => `<span role="columnheader">${esc(h)}</span>`).join("")}</div>` : ""}
    ${rows.length ? rows.join("") : `<p class="empty">${esc(empty)}</p>`}
  </div>`;

// ---- 任务：状态标签与筛选 ----

const TAG = {
  doing: ["进行中", "green"],
  merge: ["等合入", "blue"],
  blocked: ["卡住", "orange"],
  queued: ["排队", "gray"],
  todo: ["待办", "gray"],
  merged: ["已合入", "gray"],
  online: ["已上线", "gray"],
  done: ["完成", "gray"],
  failed: ["失败", "red"],
  cancelled: ["取消", "gray"],
};
const ACTIVE = new Set(["doing", "merge", "blocked", "queued"]);
const ORDER = Object.keys(TAG);
function tagOf(t) {
  if (t.delivery_stage === "merge_queued" || t.delivery_stage === "merging")
    return "merge";
  if (t.delivery_stage === "online") return "online";
  if (t.delivery_stage === "merged") return "merged";
  if (t.status === "running") return "doing";
  if (t.status === "todo") return t.queued ? "queued" : "todo";
  return TAG[t.status] ? t.status : "done";
}
const sortTasks = (list) =>
  list
    .map((t) => ({ ...t, tag: tagOf(t) }))
    .sort((a, b) => ORDER.indexOf(a.tag) - ORDER.indexOf(b.tag));
function taskList(n) {
  const { running, blocked, todo, recent } = n.tasks;
  return sortTasks([...running, ...blocked, ...todo, ...recent]);
}
function spent(t) {
  if (!t.started_at) return "";
  const end =
    t.ended_at ?? (t.status === "running" ? Date.now() : t.updated_at);
  return duration(end - t.started_at);
}

/** 任务表：各块与角色页共用；角色页不再列「角色」。 */
function taskTable(all, { withRole, empty }) {
  const list =
    state.route.extra === "all" ? all : all.filter((t) => ACTIVE.has(t.tag));
  const heads = withRole
    ? ["任务", "角色", "状态", "谁在做", "用时", "最近在做"]
    : ["任务", "状态", "谁在做", "用时", "最近在做"];
  return table(
    withRole ? "tasks" : "tasks-plain",
    heads,
    list.map((t) => {
      const [label, tone] = TAG[t.tag];
      const worker = workerLabel(t.worker);
      const doing = t.action || t.reason || "";
      const role = t.job
        ? chipLink(t.job.name, "role", roleHref(t.job.ref))
        : none;
      return `<div class="row" role="row">
        ${cell("任务", taskName(t.ref, t.title), " name plain task")}
        ${withRole ? cell("角色", role, t.job ? "" : " none") : ""}
        ${cell("状态", chip(label, tone))}
        ${cell("谁在做", worker ? `<span class="chip chip-soft clip" title="${esc(worker)}">${esc(worker)}</span>` : none, worker ? "" : " none")}
        ${cell("用时", spent(t) || "—", spent(t) ? " muted tagged" : " muted none")}
        ${cell("最近在做", doing ? `<span class="clamp" title="${esc(doing)}">${esc(doing)}</span>` : none, doing ? " note" : " note none")}
      </div>`;
    }),
    state.route.extra === "all" ? empty.all : empty.active,
  );
}

// ---- 块的页签 ----

const liveParts = (n) => n.overview.parts.filter((p) => !p.archived);
const liveConcerns = (n) => n.concerns.filter((p) => !p.archived);
const allPoints = (n) => [
  ...n.points.map((p) => ({ ...p, from: null })),
  ...n.points_below.flatMap((l) =>
    l.points.map((p) => ({ ...p, from: { ref: l.node, name: title(l) } })),
  ),
];

function partState(p) {
  const chips = [
    p.tasks.blocked ? chip(`卡住 ${p.tasks.blocked} 件`, "orange dot") : "",
    p.tasks.running ? chip(`在做 ${p.tasks.running} 件`, "green dot") : "",
  ].filter(Boolean);
  return chips.length
    ? `<span class="chips">${chips.join("")}</span>`
    : chip("空闲", "gray dot");
}

function drawParts({ node: n }) {
  return table(
    "parts",
    ["名称", "做什么", "状态", "下面", ""],
    liveParts(n).map(
      (p) => `<a class="row link" role="row" href="${esc(nodeHref(p.ref))}">
        ${cell("名称", `${ICON.part}<span>${esc(title(p))}</span>`, " name")}
        ${cell("做什么", p.what ? esc(p.what) : `<span class="muted">还没写</span>`, " text")}
        ${cell("状态", partState(p))}
        ${cell("下面", p.parts ? `${p.parts} 块` : "—", p.parts ? " muted tagged" : " muted none")}
        ${cell("", ICON.go, " go")}
      </a>`,
    ),
    "这一块没有再往下分。",
  );
}

/** 什么时候请来：优先人话 when（map edit --when）；没写时由派活提示规则拼一句。 */
function inviteText(q) {
  if (q.when) return esc(q.when);
  const rules = q.invite_when ?? [];
  const words = rules.filter((r) => !isPathRule(r)).slice(0, 4);
  const paths = rules.filter(isPathRule).slice(0, 3);
  const parts = [
    words.length ? `提到${words.map((w) => `「${esc(w)}」`).join("")}` : "",
    paths.length
      ? `改到 ${paths.map((p) => `<code>${esc(p)}</code>`).join("、")}`
      : "",
  ].filter(Boolean);
  return parts.length
    ? `${parts.join("，或")}时`
    : `<span class="muted">没写，派活时手动请</span>`;
}

function drawConcerns({ node: n }) {
  return table(
    "concerns",
    ["专员", "盯什么", "什么时候请来", "现在", ""],
    liveConcerns(n).map(
      (q) => `<a class="row link" role="row" href="${esc(nodeHref(q.ref))}">
        ${cell("专员", `${ICON.concern}<span>${esc(title(q))}</span>`, " name")}
        ${cell("盯什么", q.what ? esc(q.what) : `<span class="muted">还没写</span>`, " text")}
        ${cell("什么时候请来", inviteText(q), " note tagged")}
        ${cell("现在", q.watching ? chip(`在盯 ${q.watching} 件`, "purple") : chip("没被请", "gray"))}
        ${cell("", ICON.go, " go")}
      </a>`,
    ),
    "这一块还没有专员。",
  );
}

function drawNodeTasks({ node: n }) {
  return taskTable(taskList(n), {
    withRole: true,
    empty: { all: "这一块还没有任务。", active: "现在没有进行中的任务。" },
  });
}

function drawPoints({ node: n }) {
  return table(
    "points",
    ["原则", "为什么", "谁定的", "来自"],
    allPoints(n).map(
      (p) => `<div class="row" role="row">
        ${cell("原则", `${ICON.point}<span>${esc(p.text)}</span>`, " name plain")}
        ${cell("为什么", esc(p.why), " note")}
        ${cell("谁定的", chip(who(p.by), "amber"))}
        ${cell("来自", p.from ? `<a href="${esc(nodeHref(p.from.ref))}">${esc(p.from.name)}</a>` : "这一块", " muted tagged")}
      </div>`,
    ),
    "这一块还没写原则。",
  );
}

// ---- 组织根：角色、技能、执行者 ----

function drawRoles({ org }) {
  return table(
    "roles",
    ["角色", "干什么活", "优先派给", "交付要求", "在做", ""],
    org.roles.map(
      (r) => `<a class="row link" role="row" href="${esc(roleHref(r.ref))}">
        ${cell("角色", `${ICON.role}<span>${esc(r.name)}</span>`, " name")}
        ${cell("干什么活", esc(r.description), " text")}
        ${cell("优先派给", r.preferred.length ? `<span class="chip chip-soft clip" title="${esc(r.preferred.map(workerLabel).join("、"))}">${esc(workerLabel(r.preferred[0]))}</span>` : `<span class="muted">没指定</span>`, r.preferred.length ? "" : " none")}
        ${cell("交付要求", r.checks.length ? esc(r.checks.map(checkLabel).join("、")) : "—", r.checks.length ? " note tagged" : " note none")}
        ${cell("在做", r.running ? `${r.running} 件` : "—", r.running ? " muted tagged" : " muted none")}
        ${cell("", ICON.go, " go")}
      </a>`,
    ),
    "还没有角色。在终端用 atrium role add 建一个。",
  );
}

const onChip = (o) =>
  o.kind === "role"
    ? chipLink(`角色：${o.name}`, "role", roleHref(o.ref))
    : chipLink(`部分：${o.name}`, "soft", nodeHref(o.ref));

function skillTable(skills, empty) {
  return table(
    "skills",
    ["技能", "管什么", "挂在", "最近一次修订"],
    skills.map((s) => {
      const last = s.last ? `${day(s.last.at)} ${s.last.reason}` : "";
      return `<div class="row" role="row">
        ${cell("技能", `${ICON.skill}<span title="${esc(s.slug)}">${esc(s.name)}</span>`, " name")}
        ${cell("管什么", esc(s.description), " text")}
        ${cell("挂在", s.on.length ? `<span class="chips">${s.on.map(onChip).join("")}</span>` : `<span class="muted">还没挂</span>`)}
        ${cell("最近一次修订", last ? `<span class="clamp" title="${esc(`${last}（${who(s.last.author)}）`)}">${esc(last)}</span>` : none, last ? " note tagged" : " note none")}
      </div>`;
    }),
    empty,
  );
}
const drawSkills = ({ org }) =>
  skillTable(org.skills, "还没有组织技能。在终端用 atrium skill add 加一个。");

const ADVICE = {
  relax: () => "建议放宽一档信任",
  tighten: () => "建议收紧一档信任",
  avoid_role: (role) => `建议${role}的活先不派它`,
};
/** 待秘书确认的升降建议：浅黄条，只读。 */
function adviceBars(list) {
  return list
    .map((s) => {
      const role = s.role ?? "未指定角色";
      const reason = s.reason.startsWith(role)
        ? s.reason.slice(role.length).trim()
        : s.reason;
      const text = `${workerLabel(s.worker)} 做${role}：${reason}，${(ADVICE[s.action] ?? (() => "有调整建议"))(role)}。`;
      return `<div class="advice">${ICON.advice}<span class="advice-text">${esc(text)}</span><span class="advice-wait">等秘书确认</span></div>`;
    })
    .join("");
}

const passTone = (rate) =>
  rate >= 0.8 ? "good" : rate >= 0.5 ? "fair" : "poor";

/** 执行者表：一行 = 组合 × 角色；按一次通过率排。角色页不再列「角色」。 */
function workerTable(rows, { withRole, empty }) {
  const sorted = [...rows].sort(
    (a, b) =>
      (a.role ?? "").localeCompare(b.role ?? "") * (withRole ? 1 : 0) ||
      (b.first_pass_rate ?? -1) - (a.first_pass_rate ?? -1) ||
      b.deliveries - a.deliveries,
  );
  const heads = [
    "执行者（工具 · 模型 · 强度）",
    ...(withRole ? ["角色"] : []),
    "交付",
    "一次通过",
    "平均打回",
    "一般用时",
    "出事",
    "信任",
    "",
  ];
  return table(
    withRole ? "workers" : "workers-plain",
    heads,
    sorted.map((w) => {
      const pass =
        w.first_pass_rate === null
          ? none
          : `<span class="pass pass-${passTone(w.first_pass_rate)}">${percent(w.first_pass_rate)}</span>`;
      return `<a class="row link" role="row" href="${esc(workerHref(w.worker))}">
        ${cell("执行者", `<span>${esc(workerLabel(w.worker))}</span>`, " name")}
        ${withRole ? cell("角色", w.role ? chip(w.role, "role") : `<span class="muted small">没指定</span>`) : ""}
        ${cell("交付", `${w.deliveries} 次`, " num tagged")}
        ${cell("一次通过", `${pass}${w.low_data ? `<span class="thin">数据少</span>` : ""}`, " pass-cell tagged")}
        ${cell("平均打回", w.average_returns.toFixed(1), " num tagged")}
        ${cell("一般用时", w.median_ms === null ? "—" : duration(w.median_ms), " num tagged")}
        ${cell("出事", w.incidents ? `<span class="bad">${w.incidents} 次</span>` : `<span class="muted">—</span>`, w.incidents ? " num tagged" : " num none")}
        ${cell("信任", trustChip(w.trust))}
        ${cell("", ICON.go, " go")}
      </a>`;
    }),
    empty,
  );
}
const WORKERS_FOOT = `<p class="foot">合入时和别人的改动冲突不算执行者的问题；少于 5 次的按模型、工具合起来看。</p>`;

function drawWorkers({ org }) {
  const filter = org.roles.find((r) => r.ref === state.route.extra);
  const rows = filter
    ? org.workers.rows.filter((w) => w.role === filter.name)
    : org.workers.rows;
  const advice = filter
    ? org.workers.suggestions.filter((s) => s.role === filter.name)
    : org.workers.suggestions;
  return `${adviceBars(advice)}${workerTable(rows, {
    withRole: true,
    empty: filter
      ? `${filter.name}还没有交付记录。`
      : "还没有交付记录；任务做完后按执行者和角色统计在这里。",
  })}${rows.length ? WORKERS_FOOT : ""}`;
}

// ---- 角色页 ----

function drawRoleTasks({ role }) {
  return taskTable(sortTasks(role.tasks), {
    withRole: false,
    empty: {
      all: "还没有任务标成这个角色。",
      active: "这个角色现在没有进行中的任务。",
    },
  });
}
function drawRoleWorkers({ role }) {
  return `${adviceBars(role.suggestions)}${workerTable(role.workers, {
    withRole: false,
    empty: "还没有人做过这个角色的活。",
  })}${role.workers.length ? WORKERS_FOOT : ""}`;
}
const drawRoleSkills = ({ role }) =>
  skillTable(role.skills, "这个角色没挂技能。");

// ---- 执行者页 ----

function drawDeliveries({ worker }) {
  return table(
    "deliveries",
    ["任务", "角色", "结果", "用时", "经过"],
    worker.deliveries.map(
      (d) => `<div class="row" role="row">
        ${cell("任务", taskName(d.task, d.title), " name plain task")}
        ${cell("角色", d.role ? chipLink(d.role.name, "role", roleHref(d.role.ref)) : none, d.role ? "" : " none")}
        ${cell("结果", chip(d.result.label, `${d.result.tone} strong`))}
        ${cell("用时", d.duration_ms === null ? "—" : duration(d.duration_ms), d.duration_ms === null ? " muted none" : " muted tagged")}
        ${cell("经过", d.story ? esc(d.story) : none, d.story ? " note" : " note none")}
      </div>`,
    ),
    "还没有交付记录。",
  );
}
function drawNotes({ worker }) {
  return table(
    "notes",
    null,
    worker.notes.map(
      (n) => `<div class="row" role="row">
        ${cell("日期", esc(n.date), " muted")}
        ${cell("内容", esc(n.text), " body")}
        ${cell("谁记的", esc(n.by), " muted small")}
      </div>`,
    ),
    "档案里还没有观察记录。",
  );
}

// ---- 页签：加一个页签只加一项。count 显示在名字旁的小圆标里。 ----

const TABS = {
  parts: {
    label: "组成部分",
    count: (d) => liveParts(d.node).length,
    draw: drawParts,
  },
  concerns: {
    label: "专员",
    count: (d) => liveConcerns(d.node).length,
    draw: drawConcerns,
  },
  tasks: {
    label: "任务",
    count: (d) =>
      (d.page === "role" ? sortTasks(d.role.tasks) : taskList(d.node)).filter(
        (t) => ACTIVE.has(t.tag),
      ).length,
    draw: (d) => (d.page === "role" ? drawRoleTasks(d) : drawNodeTasks(d)),
  },
  roles: {
    label: "角色",
    count: (d) => d.org.roles.length,
    draw: drawRoles,
  },
  skills: {
    label: "技能",
    count: (d) => (d.page === "role" ? d.role.skills : d.org.skills).length,
    draw: (d) => (d.page === "role" ? drawRoleSkills(d) : drawSkills(d)),
  },
  workers: {
    label: "执行者",
    count: (d) =>
      d.page === "role"
        ? d.role.workers.length
        : new Set(d.org.workers.rows.map((w) => w.worker)).size,
    draw: (d) => (d.page === "role" ? drawRoleWorkers(d) : drawWorkers(d)),
  },
  points: {
    label: "原则",
    count: (d) => allPoints(d.node).length,
    draw: drawPoints,
  },
  deliveries: {
    label: "交付记录",
    count: (d) => d.worker.deliveries.length,
    draw: drawDeliveries,
  },
  notes: {
    label: "观察",
    count: (d) => d.worker.notes.length,
    draw: drawNotes,
  },
};
/** 这一页有哪些页签（第一个是默认）；角色页的「执行者」叫「谁做得好」。 */
function tabsOf(d) {
  if (d.page === "role") return ["tasks", "workers", "skills"];
  if (d.page === "worker") return ["deliveries", "notes"];
  return d.org
    ? ["parts", "roles", "skills", "workers", "points"]
    : ["parts", "concerns", "tasks", "points"];
}
const tabLabel = (d, id) =>
  d.page === "role" && id === "workers" ? "谁做得好" : TABS[id].label;

// ---- 页头：小字类别、标题、属性行、介绍 ----

const KIND = { org: "组织", project: "部分", module: "部分", concern: "专员" };
const props = (rows) =>
  `<dl class="props">${rows
    .map(
      ([label, body]) =>
        `<div class="prop"><dt>${esc(label)}</dt><dd>${body}</dd></div>`,
    )
    .join("")}</dl>`;
const chips = (list, empty) =>
  list.length
    ? `<span class="chips">${list.join("")}</span>`
    : `<span class="muted">${esc(empty)}</span>`;

function heading(d) {
  if (d.page === "role") {
    const r = d.role;
    return {
      kind: "角色",
      name: r.name,
      props: props([
        [
          "优先派给",
          chips(
            r.preferred.map((w) => chip(workerLabel(w), "soft")),
            "没指定，按额度和档案挑",
          ),
        ],
        [
          "交付要求",
          chips(
            r.checks.map((c) => chip(checkLabel(c), "green")),
            "按执行者档案",
          ),
        ],
        [
          "技能",
          chips(
            r.skills.map((s) => chip(s.name, "role")),
            "没挂",
          ),
        ],
      ]),
      intro: [r.description],
    };
  }
  if (d.page === "worker") {
    const w = d.worker;
    const total = w.stats.reduce((n, s) => n + s.deliveries, 0);
    const rated = w.stats.filter((s) => s.first_pass_rate !== null);
    const weight = rated.reduce((n, s) => n + s.deliveries, 0);
    const pass = weight
      ? rated.reduce((n, s) => n + s.first_pass_rate * s.deliveries, 0) / weight
      : null;
    return {
      kind: "执行者",
      name: workerLabel(w.worker),
      props: props([
        ["信任", trustChip(w.trust)],
        [
          "交付",
          chips(
            total
              ? [
                  chip(`${total} 次`, "soft"),
                  ...(pass === null
                    ? []
                    : [chip(`一次通过 ${percent(pass)}`, "soft")]),
                ]
              : [],
            "还没交付过",
          ),
        ],
        [
          "接过的角色",
          chips(
            w.stats.filter((s) => s.role).map((s) => chip(s.role, "role")),
            "还没有",
          ),
        ],
      ]),
      intro: [],
    };
  }
  const n = d.node;
  return {
    kind: KIND[n.kind] ?? "部分",
    name: title(n),
    props: "",
    intro: (n.overview.what || "")
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean),
    noIntro: "这一块还没写是做什么的。",
  };
}

// ---- 画 ----

function crumbsOf() {
  const d = state.mode === "ok" ? state.data : null;
  const root = state.root
    ? { ref: state.root.ref, name: title(state.root) }
    : null;
  if (!d) return root ? [{ ...root, url: nodeHref(root.ref) }] : [];
  if (d.page === "node")
    return d.node.chain.map((c) => ({ name: title(c), url: nodeHref(c.ref) }));
  const top = root ? [{ name: root.name, url: nodeHref(root.ref) }] : [];
  return d.page === "role"
    ? [
        ...top,
        { name: "角色", url: nodeHref(root?.ref, "roles") },
        { name: d.role.name },
      ]
    : [
        ...top,
        { name: "执行者", url: nodeHref(root?.ref, "workers") },
        { name: workerLabel(d.worker.worker) },
      ];
}

function drawCrumbs() {
  const list = crumbsOf();
  const ok = state.mode === "ok";
  const html = list
    .map((c, i) =>
      i === list.length - 1 && ok
        ? `<span class="crumb current" aria-current="page">${esc(c.name)}</span>`
        : `<a class="crumb" href="${esc(c.url)}">${esc(c.name)}</a>`,
    )
    .join(`<span class="sep" aria-hidden="true">/</span>`);
  if (html === state.drawn.crumbs) return;
  state.drawn.crumbs = html;
  $("crumbs").innerHTML = html;
}

function drawLive() {
  const live = $("live");
  if (state.mode === "expired") {
    live.dataset.state = "off";
    live.textContent = "登录已失效";
  } else if (live.dataset.state === "down") {
    live.textContent = "已断开，重连中";
  } else if (state.now) {
    live.dataset.state = state.now.running ? "on" : "idle";
    live.textContent = state.now.running
      ? `在做 ${state.now.running} 件`
      : "都停着";
  }
}

const notice = (head, body) =>
  `<section class="notice"><h1>${head}</h1><p>${body}</p></section>`;
const MISSING = {
  node: (ref) => [
    "找不到这一块",
    `链接里的 <code>${esc(ref)}</code> 不存在，可能已经删掉了。`,
  ],
  role: (ref) => [
    "找不到这个角色",
    `链接里的 <code>${esc(ref)}</code> 不存在，可能已经删掉了。`,
  ],
  // 服务端说得清原因（名字不合法，或没有交付记录也没有档案），照着说。
  worker: (ref, why) => [
    "找不到这个执行者",
    why ? `${esc(why)}。` : `<code>${esc(ref)}</code> 不存在。`,
  ],
};

function pageHtml() {
  const rootLink = state.root
    ? `<a href="${esc(nodeHref(state.root.ref))}">回到最上层</a>`
    : "";
  if (state.mode === "expired")
    return notice(
      "全景网页的登录已失效",
      "在终端运行 <code>atrium map</code>，会重新打开一个登录链接。",
    );
  if (state.mode === "empty")
    return notice(
      "还没有组织树",
      "在终端运行 <code>atrium org import --repo 仓库</code> 建一份。",
    );
  if (state.mode === "missing") {
    const { page, ref, why } = state.missing;
    const [head, body] = MISSING[page](ref, why);
    return notice(head, `${body}${rootLink}`);
  }
  if (state.mode === "down" || !state.data)
    return notice(
      state.mode === "down" ? "暂时取不到数据" : "正在读取…",
      state.mode === "down" ? "服务可能在重启，页面会自己重试。" : "",
    );
  const d = state.data;
  const { page, ref } = state.route;
  const at = page === "worker" ? d.worker.worker : (ref ?? d.node?.ref);
  const ids = tabsOf(d);
  const tab = ids.includes(state.route.tab) ? state.route.tab : ids[0];
  const head = heading(d);
  const tabs = ids
    .map(
      (id) =>
        `<a class="tab" role="tab" href="${esc(href(page, at, id))}" aria-selected="${id === tab}">
      <span>${esc(tabLabel(d, id))}</span><span class="badge">${TABS[id].count(d)}</span>
    </a>`,
    )
    .join("");
  const pills =
    tab === "tasks"
      ? [
          ["", "进行中"],
          ["all", "全部"],
        ]
      : tab === "workers" && d.org && d.org.roles.length
        ? [["", "全部"], ...d.org.roles.map((r) => [r.ref, r.name])]
        : [];
  const current = pills.some(([id]) => id === state.route.extra)
    ? state.route.extra
    : "";
  const filters = pills.length
    ? `<div class="filters" aria-label="筛选">${pills
        .map(
          ([id, label]) =>
            `<a class="filter" href="${esc(href(page, at, tab, id))}" aria-current="${id === current}">${esc(label)}</a>`,
        )
        .join("")}</div>`
    : "";
  const intro = head.intro.length
    ? head.intro.map((p) => `<p>${esc(p)}</p>`).join("")
    : head.noIntro
      ? `<p class="muted">${esc(head.noIntro)}</p>`
      : "";
  return `<header class="intro">
      <span class="kind">${esc(head.kind)}</span>
      <h1>${esc(head.name)}</h1>
      ${head.props}
      ${intro}
    </header>
    <section class="view">
      <div class="tabbar"><div class="tabs" role="tablist" aria-label="视图">${tabs}</div>${filters}</div>
      <div role="tabpanel">${TABS[tab].draw(d)}</div>
    </section>`;
}

function draw() {
  drawCrumbs();
  drawLive();
  const html = pageHtml();
  if (html !== state.drawn.page) {
    state.drawn.page = html;
    $("page").innerHTML = html;
  }
  const d = state.mode === "ok" ? state.data : null;
  document.title = d ? `${heading(d).name} · Atrium 全景` : "Atrium 全景";
}

// ---- 路由与刷新 ----

function fail(error) {
  if (error instanceof Expired) {
    state.mode = "expired";
    document.body.classList.add("expired");
  } else {
    $("live").dataset.state = "down";
    if (!state.data) state.mode = "down";
  }
  draw();
}

/** 取一页的数据；组织根另带角色、技能、执行者。 */
async function fetchPage(route, key) {
  if (route.page === "role")
    return {
      page: "role",
      role: await get(`/roles/${encodeURIComponent(key)}`),
    };
  if (route.page === "worker")
    return {
      page: "worker",
      worker: await get(`/workers/${encodeURIComponent(route.ref)}`),
    };
  if (key !== state.root.ref)
    return {
      page: "node",
      node: await get(`/nodes/${encodeURIComponent(key)}`),
    };
  const [node, roles, skills, workers] = await Promise.all([
    get(`/nodes/${encodeURIComponent(key)}`),
    get("/roles"),
    get("/skills"),
    get("/workers"),
  ]);
  return {
    page: "node",
    node,
    org: { roles: roles.roles, skills: skills.skills, workers },
  };
}

/** 取当前地址对应的页；move 为 true 表示换了页（滚回顶部、焦点给正文）。 */
async function load(move = false) {
  const seq = ++state.seq;
  const route = parseRoute();
  if (!state.root) {
    const { root, tree } = await get("/tree?depth=0");
    state.root = tree
      ? { ref: root, name: tree.name, alias: tree.alias }
      : null;
  }
  if (!state.root) {
    state.mode = "empty";
    return draw();
  }
  const before = pageKey(state.route, state.root.ref);
  const key = pageKey(route, state.root.ref);
  const changed = key !== before || state.mode !== "ok";
  state.route = route;
  // 切到看过的页：先用上次的数据画，不留白。
  if (changed && state.cache.has(key)) {
    state.data = state.cache.get(key);
    state.mode = "ok";
    draw();
  } else if (!changed) draw();
  try {
    const data = await fetchPage(route, key);
    if (seq !== state.seq) return;
    state.cache.set(key, data);
    state.data = data;
    state.mode = "ok";
  } catch (error) {
    if (seq !== state.seq) return;
    if (!(error instanceof Missing)) throw error;
    state.mode = "missing";
    state.missing = {
      page: route.page,
      ref: route.ref ?? key,
      why: error.message,
    };
    state.data = null;
  }
  draw();
  if (move && changed) {
    window.scrollTo({ top: 0 });
    $("page").focus({ preventScroll: true });
  }
}

async function refresh() {
  if (state.mode === "expired") return;
  try {
    state.now = await get("/now");
    if ($("live").dataset.state === "down") $("live").dataset.state = "on";
    await load();
  } catch (error) {
    fail(error);
  }
}

function subscribe() {
  const source = new EventSource("/api/map/stream");
  source.addEventListener("hello", () => {
    $("live").dataset.state = "on";
    refresh();
  });
  source.addEventListener("changed", () => refresh());
  source.onerror = async () => {
    $("live").dataset.state = "down";
    drawLive();
    // 会话失效时 EventSource 会一直重试：先问一次，失效就停下。
    try {
      await get("/now");
    } catch (error) {
      if (error instanceof Expired) {
        source.close();
        fail(error);
      }
    }
  };
}

window.addEventListener("hashchange", () => load(true).catch(fail));
await refresh();
if (state.mode !== "expired") subscribe();
// 执行者的最近动作与「用时」不改账本，隔一会儿重取一次。
setInterval(() => {
  if (!document.hidden) refresh();
}, 30000);
