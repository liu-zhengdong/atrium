// Atrium 全景网页：只读，唯一能写的是拍板选项单（「选项」页签，POST /api/choices/cN/pick|pass）。
// 数据来自与 `atrium map --json` 相同的接口，订阅 /api/map/stream 的失效通知，变了只重取并重画，不整页重载。
// 一页一件东西：面包屑 → 小字类别、大标题、属性行与介绍 → 页签。三类页：
// - 块（组织节点）：#o2/tasks/all。组织根的页签是下属部门／选项／负责人／专员／技能／执行者／要点，执行者可按专员筛（#o1/workers/r1）；
//   挂了资料的块多一个「资料」页签（只看，取与归档走命令行）；
//   有选项单的块多一个「选项」页签（本块及下层的，等你拍板的在前）；组织根顶部有「等你拍板：N」入口；
// - 专员：#r1/workers，页签是任务／谁做得好／技能；
// - 执行者：#w/claude+opus:high/notes，页签是交付记录／观察；
// - 负责人（leader）：#a1/events，页签是备忘／处理过的事／上交；
// - 秘书：#secretary，只有备忘；用户：#u1，只有决定记录（你拍板的）。
// 决定记录现取列表、可按关键词查；块页的「决定」页签是挂在本块及上级的。
// 当前页、页签与筛选都写在 hash 里，刷新与前进后退都回到原处。

import { escapeHtml as esc, linkify, liveText } from "./format.js";
import {
  fetchRootOrg,
  keepWorkers,
  sseReloadOnHello,
  withWorkers,
} from "./boot.js";

const $ = (id) => document.getElementById(id);

const state = {
  root: null,
  now: null,
  /** 看过的页先用旧数据画出来，再换新的，切换时不闪白。键是页（o2、r1、w/…）。 */
  cache: new Map(),
  route: { page: "node", ref: null, tab: "", extra: "" },
  /** 当前页的数据：{ page: "node", node, org? } / { page: "role", role } / { page: "worker", worker } / { page: "leader", leader }。 */
  data: null,
  /** 页面的整体状态：ok / missing（链接里的东西不存在）/ empty（没有组织树）/ down / expired / forbidden。 */
  mode: "loading",
  missing: null,
  seq: 0,
  drawn: { crumbs: "", page: "" },
};

// ---- 取数据 ----

class Expired extends Error {}
class Forbidden extends Error {}
class Missing extends Error {}
async function get(path) {
  const response = await fetch(`/api/map${path}`, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (response.status === 401) throw new Expired();
  if (response.status === 403) throw new Forbidden();
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
  node: [
    "parts",
    "tasks",
    "leaders",
    "roles",
    "skills",
    "workers",
    "points",
    "choices",
    "materials",
    "decisions",
  ],
  role: ["tasks", "workers", "skills"],
  worker: ["deliveries", "notes"],
  leader: ["memo", "events", "escalations", "decisions"],
};
const REF = {
  node: /^o[1-9]\d{0,8}$/,
  role: /^r[1-9]\d{0,8}$/,
  leader: /^(secretary|u1|a[1-9]\d{0,8})$/,
};

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
  } else if (REF.leader.test(head)) {
    page = "leader";
    ref = head;
  } else if (REF.node.test(head)) ref = head;
  const [tab = "", extra = ""] = parts;
  const ok = PAGE_TABS[page].includes(tab);
  return {
    page,
    ref,
    tab: ok ? tab : "",
    extra:
      ok &&
      (tab === "tasks" || tab === "decisions" || tab === "roles") &&
      extra === "all"
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
const leaderHref = (ref, tab, extra) => href("leader", ref, tab, extra);
const pageKey = (route, rootRef) =>
  route.page === "worker"
    ? `w/${route.ref}`
    : route.page === "node"
      ? (route.ref ?? rootRef)
      : route.ref;

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
/** 时刻：今天只给时分，其余带月日。 */
const clock = (at) => {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${day(at)} ${hm}`;
};
const title = (n) => n.alias || n.name;
const who = (by) =>
  by === "secretary" ? "秘书" : String(by ?? "").replace(/^u1\b/, "你");
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
  role: `<svg class="icon icon-role" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>`,
  leader: `<svg class="icon icon-leader" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="3.5"/><path d="M5 21v-1.5A5.5 5.5 0 0 1 10.5 14h3a5.5 5.5 0 0 1 5.5 5.5V21"/><path d="M12 14l-1.2 3.5L12 19l1.2-1.5z"/></svg>`,
  skill: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z"/><path d="M8 7h6"/></svg>`,
  point: `<svg class="icon icon-point" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/></svg>`,
  go: `<svg class="icon icon-go" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`,
};
const chip = (text, tone) =>
  `<span class="chip chip-${tone}">${esc(text)}</span>`;
/** 可点的胶囊：放在不是整行链接的行里（整行链接里不能再套链接）。 */
const chipLink = (text, tone, url) =>
  `<a class="chip chip-${tone} chip-link" href="${esc(url)}">${esc(text)}</a>`;
const none = `<span class="muted">—</span>`;
/**
 * 任务名：编号在前（与状态栏、top、汇报里的 tN 对得上），标题折行时编号不动；leader 派的在标题下注明。
 * more 是标题下的另一行小字（总任务的子任务）。
 */
const taskName = (ref, title, by, more = "") =>
  `<span class="task-ref">${esc(ref)}</span><span class="task-title">${esc(title)}${by ? `<span class="task-by">${esc(by.name)}派的</span>` : ""}${more}</span>`;
const partLink = (p) =>
  `<a href="${esc(nodeHref(p.ref))}">${esc(title(p))}</a>`;
const cell = (label, body, extra = "") =>
  `<span class="cell${extra}" role="cell" data-label="${esc(label)}">${body}</span>`;
/** 表格；没有行时只说一句空状态，不出表头。 */
const table = (kind, heads, rows, empty) =>
  rows.length
    ? `<div class="table table-${kind}" role="table">
    ${heads ? `<div class="row head" role="row">${heads.map((h) => `<span role="columnheader">${esc(h)}</span>`).join("")}</div>` : ""}
    ${rows.join("")}
  </div>`
    : `<p class="empty">${esc(empty)}</p>`;

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
const ENDED = new Set(["merged", "online", "done", "cancelled"]);
const ORDER = Object.keys(TAG);
/** 总任务（t190）的汇总状态对应的标签：它自己从不在跑，状态由子孙推出。 */
const TOTAL_TAG = {
  running: "doing",
  blocked: "blocked",
  online: "online",
  cancelled: "cancelled",
  todo: "todo",
};
function tagOf(t) {
  if (t.total)
    return t.status === "cancelled"
      ? "cancelled"
      : (TOTAL_TAG[t.total.status] ?? "todo");
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
  const all = [...running, ...blocked, ...todo, ...recent];
  // 总任务的子任务收进总任务那一行，展开才看（t190）。
  const totals = new Set(all.filter((t) => t.total).map((t) => t.ref));
  return sortTasks(all.filter((t) => !t.parent || !totals.has(t.parent)));
}
/** 总任务那一行下面的展开：直接子任务各一行（编号、标题、状态），更多的写个数。 */
function totalChildren(t) {
  const rows = t.total.children.map((c) => {
    const [label] = TAG[c.total ? "todo" : tagOf(c)] ?? TAG.todo;
    return `<li><span class="task-ref">${esc(c.ref)}</span> ${esc(c.title)} <span class="muted">${esc(c.total ? "总任务" : label)}</span></li>`;
  });
  return `<details class="total-children"><summary>${esc(`${t.total.label} ${t.total.progress} · 展开 ${t.total.children.length + t.total.more} 个子任务`)}</summary><ul>${rows.join("")}${t.total.more ? `<li class="muted">${esc(`还有 ${t.total.more} 个：atrium task tree ${t.ref}`)}</li>` : ""}</ul></details>`;
}
function spent(t) {
  if (!t.started_at) return "";
  const end =
    t.ended_at ?? (t.status === "running" ? Date.now() : t.updated_at);
  return duration(end - t.started_at);
}

/** 状态格：紧急、修复、闲时（普通不标）的标记在前，状态在后。 */
function statusChips(t, label, tone) {
  const marks = [
    t.priority === "urgent" ? chip("紧急", "red") : "",
    t.priority === "fix" ? chip("修复", "orange") : "",
    t.priority === "idle" && !ENDED.has(t.tag) ? chip("闲时", "gray") : "",
  ].join("");
  return marks
    ? `<span class="chips">${marks}${chip(label, tone)}</span>`
    : chip(label, tone);
}

/** 表里任务按优先级计数：紧急 K · 修复 M · 普通 N · 闲时 I（为 0 的不写）；没有任务为空。 */
const PRIORITY_WORDS = [
  ["urgent", "紧急"],
  ["fix", "修复"],
  ["normal", "普通"],
  ["idle", "闲时"],
];
function typeCounts(list) {
  const text = PRIORITY_WORDS.map(([key, word]) => [
    word,
    list.filter((t) => (t.priority ?? "normal") === key).length,
  ])
    .filter(([, n]) => n)
    .map(([word, n]) => `${word} ${n}`)
    .join(" · ");
  return text ? `<p class="muted type-counts">${esc(text)}</p>` : "";
}

/** 任务表：各块与专员页共用；专员页不再列「专员」。 */
function taskTable(all, { withRole, empty }) {
  const list =
    state.route.extra === "all" ? all : all.filter((t) => ACTIVE.has(t.tag));
  const heads = withRole
    ? ["任务", "专员", "状态", "谁在做", "用时", "最近在做"]
    : ["任务", "状态", "谁在做", "用时", "最近在做"];
  return (
    typeCounts(list) +
    table(
      withRole ? "tasks" : "tasks-plain",
      heads,
      list.map((t) => {
        const [tagLabel, tone] = TAG[t.tag];
        const label = t.total ? `${tagLabel} ${t.total.progress}` : tagLabel;
        const worker = workerLabel(t.worker);
        const workerAt =
          worker && t.host_name ? `${worker} @ ${t.host_name}` : worker;
        const doing = t.action || t.reason || "";
        // 最新备注只在任务没结时显示：作者用名字（Atrium 负责人、你）。
        const note = t.note && !ENDED.has(t.tag) ? t.note : null;
        const noteLine = note
          ? `<span class="clamp note-line" title="${esc(`${note.by.name}：${note.text}`)}"><span class="note-by">${esc(note.by.name)}：</span>${esc(note.text)}</span>`
          : "";
        const recent = doing
          ? `<span class="clamp" title="${esc(doing)}">${linkify(doing)}</span>${noteLine}`
          : noteLine;
        const role = t.job
          ? chipLink(t.job.name, "role", roleHref(t.job.ref))
          : none;
        return `<div class="row" role="row">
        ${cell("任务", taskName(t.ref, t.title, t.by, t.total ? totalChildren(t) : ""), " name plain task")}
        ${withRole ? cell("专员", role, t.job ? "" : " none") : ""}
        ${cell("状态", statusChips(t, label, tone))}
        ${cell("谁在做", workerAt ? `<span class="chip chip-soft clip" title="${esc(workerAt)}">${esc(workerAt)}</span>` : none, workerAt ? "" : " none")}
        ${cell("用时", spent(t) || "—", spent(t) ? " muted tagged" : " muted none")}
        ${cell("最近在做", recent || none, recent ? " note" : " note none")}
      </div>`;
      }),
      state.route.extra === "all" ? empty.all : empty.active,
    )
  );
}

// ---- 块的页签 ----

const liveParts = (n) => n.overview.parts.filter((p) => !p.archived);
/** 要点页签：本块的，再加下层各块的（注明来自哪一块）。 */
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

function drawNodeTasks({ node: n }) {
  return taskTable(taskList(n), {
    withRole: true,
    empty: { all: "这一块还没有任务。", active: "现在没有进行中的任务。" },
  });
}

// ---- 资料：挂在这一块上的设计稿、调研报告；网页只看，取与归档走命令行 ----

const materialSize = (bytes) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const liveMaterials = (n) => (n.materials ?? []).filter((m) => !m.archived);

function drawMaterials({ node: n }) {
  return table(
    "materials",
    ["资料", "版本", "最近读取", "状态"],
    (n.materials ?? []).map((m) => {
      const state = m.archived
        ? chip("已归档", "gray")
        : m.superseded_by
          ? chip(`被 ${m.superseded_by} 取代`, "orange")
          : chip("在用", "green");
      // 被取代的状态标签已说明白，不再重复「疑似没用」。
      const hint =
        m.stale && m.stale.kind !== "superseded"
          ? `<span class="finding-reason" title="${esc(m.stale.reason)}">${chip("疑似没用", "amber")} ${esc(m.stale.reason)}</span>`
          : m.keep_note
            ? `<span class="finding-reason muted">留下：${esc(m.keep_note)}</span>`
            : "";
      return `<div class="row" role="row">
        ${cell("资料", `<span class="task-ref">${esc(m.ref)}</span><span class="task-title">${esc(m.name)}<span class="task-parts">${esc(m.note || "（没写说明）")}</span></span>`, " name plain task")}
        ${cell("版本", `<span class="finding-step">v${esc(m.version)} · ${esc(m.kind === "dir" ? `${m.files} 个文件` : "文件")} · ${esc(materialSize(m.bytes))}</span><code class="finding-command">atrium material get ${esc(m.ref)}</code>`, " text")}
        ${cell("最近读取", m.last_read_at ? esc(`${clock(m.last_read_at)} ${who(m.last_read_by)}`) : `<span class="muted">还没人读过</span>`, " muted tagged")}
        ${cell("状态", `<span class="chips">${state}</span>${hint}`, " fate")}
      </div>`;
    }),
    "这一块还没挂资料。在终端用 atrium material add 节点 文件或目录 --note 一句话 挂上，派活时执行者会看到清单。",
  );
}

// ---- 选项：调研提的选项单，等你拍板的在前；拍板是网页唯一能写的地方 ----

const CHOICE_STATUS = {
  open: ["等你拍板", "amber"],
  picked: ["已拍板", "blue"],
  passed: ["这轮都不要", "gray"],
};
const OPTION_FACTS = [
  ["gain", "能多做到"],
  ["why_now", "为什么现在"],
  ["cost", "代价"],
  ["skip", "不做会怎样"],
];
const openChoices = (n) => (n.choices ?? []).filter((c) => c.status === "open");

function optionHtml(c, o, open) {
  const recommended = c.recommend.includes(o.seq);
  const fate =
    o.picked === true
      ? chip(`已选 · ${o.task}`, "green")
      : o.picked === false
        ? chip(`没选 · 记为 ${o.decision}`, "gray")
        : "";
  const head = `<span class="option-seq">${o.seq}</span><span class="option-title">${esc(o.title)}</span>${recommended ? chip("推荐", "purple") : ""}${fate}`;
  const facts = OPTION_FACTS.map(
    ([key, label]) =>
      `<div class="option-fact"><dt>${esc(label)}</dt><dd>${esc(o[key])}</dd></div>`,
  ).join("");
  const basis = o.basis.length
    ? `<div class="option-fact"><dt>依据</dt><dd>${o.basis.map(linkify).join("；")}</dd></div>`
    : "";
  return `<li class="choice-option${o.picked === true ? " picked" : ""}">
    ${
      open
        ? `<label class="option-head"><input type="checkbox" name="pick" value="${o.seq}">${head}</label>`
        : `<div class="option-head">${head}</div>`
    }
    <dl class="option-facts">${facts}${basis}</dl>
  </li>`;
}

function choiceHtml(c, here) {
  const [label, tone] = CHOICE_STATUS[c.status] ?? [c.status, "gray"];
  const open = c.status === "open";
  const where =
    c.node !== here
      ? `<a href="${esc(nodeHref(c.node, "choices"))}">${esc(c.node_alias || c.node_name)}</a>`
      : "";
  const decider = (by) => (!by || by === "u1" ? "你" : esc(by));
  const handed = open && c.decider && c.decider !== "u1";
  const meta = [
    `${who(c.created_by)}提于 ${clock(c.created_at)}`,
    c.task ? `出自 ${esc(c.task)}` : "",
    c.decided_at ? `${decider(c.decided_by)}拍板于 ${clock(c.decided_at)}` : "",
    handed ? `拍板权已下放给 ${esc(c.decider)}，你也可以直接拍` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const options = `<ol class="choice-options">${c.options.map((o) => optionHtml(c, o, open)).join("")}</ol>`;
  const comments = (c.comments ?? []).length
    ? `<div class="choice-comments"><span class="choice-label">意见</span><ul>${c.comments
        .map((m) => {
          const prefer = m.prefer?.length
            ? `（倾向选项 ${m.prefer.join("、")}）`
            : "";
          const basis = m.basis?.length
            ? `；补依据：${m.basis.map(linkify).join("；")}`
            : "";
          return `<li><strong>${esc(who(m.by))}</strong>：${esc(m.text)}${prefer}${basis}</li>`;
        })
        .join("")}</ul></div>`
    : "";
  const small = c.small?.text
    ? `<p class="choice-small muted small">${esc(c.small.text)}</p>`
    : "";
  const recommend = `<p class="choice-recommend"><span class="choice-label">推荐</span>选项 ${c.recommend.join("、")}——${esc(c.why)}</p>${small}${comments}`;
  const body = open
    ? `<form class="choice-form" data-choice="${esc(c.ref)}">
        ${options}
        ${recommend}
        <label class="choice-note"><span class="choice-label">说明（可不写）</span>
          <textarea name="note" rows="2" maxlength="1000" placeholder="为什么选这些、为什么不要那些；没选的会连同这句记进决定记录，下一轮调研读得到"></textarea>
        </label>
        <div class="choice-actions">
          <button type="submit" value="pick">做勾选的</button>
          <button type="submit" value="pass" class="secondary">这轮都不要</button>
          <span class="choice-error" role="alert"></span>
        </div>
      </form>`
    : `${options}${recommend}${c.note ? `<p class="choice-recommend"><span class="choice-label">${decider(c.decided_by)}的说明</span>${esc(c.note)}</p>` : ""}`;
  return `<article class="choice" id="choice-${esc(c.ref)}" data-status="${esc(c.status)}">
    <header class="choice-head">
      <span class="task-ref">${esc(c.ref)}</span>
      <h2>${esc(c.title)}</h2>
      <span class="chips">${chip(label, tone)}</span>
      ${where ? `<span class="choice-from">来自${where}</span>` : ""}
    </header>
    <p class="choice-meta muted small">${meta}</p>
    ${body}
  </article>`;
}

function drawChoices({ node: n }) {
  const list = n.choices ?? [];
  return list.length
    ? `<div class="choices">${list.map((c) => choiceHtml(c, n.ref)).join("")}</div>`
    : `<p class="empty">这一块还没有选项单。调研后会把下一步的几个方向列在这里，等你拍板。</p>`;
}

/** 重画会换掉整页 HTML：先记下正在填的勾选与说明，画完再放回去。 */
function formState() {
  const saved = new Map();
  const search = document.querySelector("form[data-decision-search]");
  if (search)
    saved.set("decision-search", {
      value: search.elements.q.value,
      focused: document.activeElement === search.elements.q,
    });
  for (const form of document.querySelectorAll("form[data-choice]"))
    saved.set(form.dataset.choice, {
      picks: [...form.querySelectorAll("input[name=pick]:checked")].map(
        (i) => i.value,
      ),
      note: form.elements.note.value,
      focused: document.activeElement === form.elements.note,
    });
  return saved;
}
function restoreForms(saved) {
  const search = document.querySelector("form[data-decision-search]");
  const typed = saved.get("decision-search");
  if (search && typed) {
    search.elements.q.value = typed.value;
    if (typed.focused) search.elements.q.focus({ preventScroll: true });
  }
  for (const form of document.querySelectorAll("form[data-choice]")) {
    const s = saved.get(form.dataset.choice);
    if (!s) continue;
    for (const input of form.querySelectorAll("input[name=pick]"))
      input.checked = s.picks.includes(input.value);
    form.elements.note.value = s.note;
    if (s.focused) form.elements.note.focus({ preventScroll: true });
  }
}

async function decide(form, action) {
  const ref = form.dataset.choice;
  const error = form.querySelector(".choice-error");
  const picks = [...form.querySelectorAll("input[name=pick]:checked")].map(
    (i) => Number(i.value),
  );
  if (action === "pick" && !picks.length) {
    error.textContent = "先勾选要做的选项；都不要就点「这轮都不要」。";
    return;
  }
  const note = form.elements.note.value.trim();
  error.textContent = "";
  for (const button of form.querySelectorAll("button")) button.disabled = true;
  try {
    const response = await fetch(
      `/api/choices/${encodeURIComponent(ref)}/${action}`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(
          action === "pick"
            ? { picks, ...(note ? { note } : {}) }
            : note
              ? { note }
              : {},
        ),
      },
    );
    if (response.status === 401) throw new Expired();
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    await refresh();
  } catch (e) {
    if (e instanceof Expired) return fail(e);
    error.textContent = `没拍成：${e.message}`;
    for (const button of form.querySelectorAll("button"))
      button.disabled = false;
  }
}

function drawPoints({ node: n }) {
  return table(
    "points",
    ["要点", "为什么", "谁定的", "来自"],
    allPoints(n).map(
      (p) => `<div class="row" role="row">
        ${cell("要点", `${ICON.point}<span>${esc(p.text)}</span>`, " name plain")}
        ${cell("为什么", esc(p.why), " note")}
        ${cell("谁定的", chip(who(p.by), "amber"))}
        ${cell("来自", p.from ? `<a href="${esc(nodeHref(p.from.ref))}">${esc(p.from.name)}</a>` : "这一块", " muted tagged")}
      </div>`,
    ),
    "这一块还没写要点。",
  );
}

// ---- 组织根：专员、技能、执行者 ----

/** 组织根的专员页签：专员只记分工（做什么、优先派给、交付要求、挂的技能）。 */
const drawRoles = (d) =>
  roleTable(
    d.team ?? [],
    "还没有专员。在终端用 atrium specialist add 建一个。",
  );

function roleTable(list, empty) {
  return table(
    "roles",
    ["专员", "干什么活", "优先派给", "交付要求", "在做", ""],
    list.map(
      (r) => `<a class="row link" role="row" href="${esc(roleHref(r.ref))}">
        ${cell("专员", `${ICON.role}<span>${esc(r.name)}</span>`, " name")}
        ${cell("干什么活", esc(r.description), " text")}
        ${cell("优先派给", r.preferred.length ? `<span class="chip chip-soft clip" title="${esc(r.preferred.map(workerLabel).join("、"))}">${esc(workerLabel(r.preferred[0]))}</span>` : `<span class="muted">没指定</span>`, r.preferred.length ? "" : " none")}
        ${cell("交付要求", r.checks.length ? esc(r.checks.map(checkLabel).join("、")) : "—", r.checks.length ? " note tagged" : " note none")}
        ${cell("在做", r.running ? `${r.running} 件` : "—", r.running ? " muted tagged" : " muted none")}
        ${cell("", ICON.go, " go")}
      </a>`,
    ),
    empty,
  );
}

const onChip = (o) =>
  o.kind === "role"
    ? chipLink(`专员：${o.name}`, "role", roleHref(o.ref))
    : chipLink(`部门：${o.name}`, "soft", nodeHref(o.ref));

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

const passTone = (rate) =>
  rate >= 0.8 ? "good" : rate >= 0.5 ? "fair" : "poor";

/** 执行者表：一行 = 组合 × 专员；按一次通过率排。专员页不再列「专员」。 */
function workerTable(rows, { withRole, empty }) {
  const sorted = [...rows].sort(
    (a, b) =>
      (a.role ?? "").localeCompare(b.role ?? "") * (withRole ? 1 : 0) ||
      (b.first_pass_rate ?? -1) - (a.first_pass_rate ?? -1) ||
      b.deliveries - a.deliveries,
  );
  const heads = [
    "执行者（工具 · 模型 · 强度）",
    ...(withRole ? ["专员"] : []),
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
        ${withRole ? cell("专员", w.role ? chip(w.role, "role") : `<span class="muted small">没指定</span>`) : ""}
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
  if (org.workers.pending) return `<p class="muted">正在统计执行者…</p>`;
  const filter = org.roles.find((r) => r.ref === state.route.extra);
  const rows = filter
    ? org.workers.rows.filter((w) => w.role === filter.name)
    : org.workers.rows;
  return `${workerTable(rows, {
    withRole: true,
    empty: filter
      ? `${filter.name}还没有交付记录。`
      : "还没有交付记录；任务做完后按执行者和专员统计在这里。",
  })}${rows.length ? WORKERS_FOOT : ""}`;
}

// ---- 专员页 ----

function drawRoleTasks({ role }) {
  return taskTable(sortTasks(role.tasks), {
    withRole: false,
    empty: {
      all: "还没有任务标成这个专员。",
      active: "这个专员现在没有进行中的任务。",
    },
  });
}
function drawRoleWorkers({ role }) {
  return `${workerTable(role.workers, {
    withRole: false,
    empty: "还没有人做过这个专员的活。",
  })}${role.workers.length ? WORKERS_FOOT : ""}`;
}
const drawRoleSkills = ({ role }) =>
  skillTable(role.skills, "这个专员没挂技能。");

// ---- 执行者页 ----

function drawDeliveries({ worker }) {
  return table(
    "deliveries",
    ["任务", "专员", "结果", "用时", "经过"],
    worker.deliveries.map(
      (d) => `<div class="row" role="row">
        ${cell("任务", taskName(d.task, d.title), " name plain task")}
        ${cell("专员", d.role ? chipLink(d.role.name, "role", roleHref(d.role.ref)) : none, d.role ? "" : " none")}
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

// ---- 负责人（leader） ----

/**
 * 负责人现在的状态：在处理（带在处理什么）、空闲，或上次没处理完。
 * full 为 true 时（负责人页）另带上次的时间与内容。
 */
function leadState(l, full = false) {
  const w = l.wake;
  const waiting =
    l.pending && w?.status !== "running"
      ? chip(`还有 ${l.pending} 件等它`, "amber")
      : "";
  if (!w)
    return `<span class="lead-state">${chip("还没被叫醒过", "gray dot")}${waiting}</span>`;
  if (w.status === "running")
    return `<span class="lead-state">${chip("在处理", "green dot")}${w.summary ? `<span class="lead-doing">${esc(w.summary)}</span>` : ""}<span class="muted">${esc(since(w.at, full))}</span></span>`;
  const last = full
    ? `<span class="muted">上次 ${esc(clock(w.at))}${w.summary ? `：${esc(w.summary)}` : ""}</span>`
    : "";
  if (w.status === "failed" || w.status === "handed_off")
    return `<span class="lead-state">${chip(w.status === "failed" ? "上次没处理完" : "上次没处理完，已转交上级", "orange dot")}${waiting}${full && w.note ? `<span class="muted">${esc(w.note)}</span>` : ""}</span>`;
  return `<span class="lead-state">${chip("空闲", "gray dot")}${waiting}${last}</span>`;
}

/** 在处理了多久：不到一分钟说「刚开始」。 */
function since(at, full) {
  const ms = Date.now() - at;
  const long = ms < 60000 ? "刚开始" : `已 ${duration(ms)}`;
  return full ? `${clock(at)} 开始，${long}` : long;
}

/** 节点页的「负责人」一行：名字（点开是负责人页）与现在的状态；归上级管的注明是哪一块。 */
function leadProp(lead) {
  const from = lead.from
    ? `<span class="muted lead-from">管整个「${esc(title(lead.from))}」</span>`
    : "";
  return `<span class="lead">${chipLink(lead.name, "leader", leaderHref(lead.ref))}${leadState({ ...lead, pending: 0 })}${from}</span>`;
}

function drawLeaders({ org }) {
  return table(
    "leaders",
    ["负责人", "负责", "现在", "执行者", ""],
    org.leaders.map(
      (l) => `<a class="row link" role="row" href="${esc(leaderHref(l.ref))}">
        ${cell("负责人", `${ICON.leader}<span>${esc(l.name)}</span>`, " name")}
        ${cell("负责", l.nodes.length ? esc(l.nodes.map(title).join("、")) : `<span class="muted">还没指派</span>`, " text")}
        ${cell("现在", leadState(l), " note")}
        ${cell("执行者", `<span class="chip chip-soft clip" title="${esc(workerLabel(l.worker))}">${esc(workerLabel(l.worker))}</span>`)}
        ${cell("", ICON.go, " go")}
      </a>`,
    ),
    "还没有负责人。在终端用 atrium leader add 登记，再用 atrium org edit 部门 --leader aN 指派。",
  );
}

// 秘书页与负责人页共用备忘与决定记录（秘书的 kind 是 secretary，没有负责的部门与事件）。
const isSecretary = (l) => l.kind === "secretary";
function drawMemo({ leader: l }) {
  const at = l.memo_updated_at ? `${day(l.memo_updated_at)} 更新 · ` : "";
  if (isSecretary(l))
    return l.memo
      ? `<div class="memo">${esc(l.memo)}</div>
    <p class="foot">${esc(at)}秘书开新会话、换人接手先读这份备忘，写的是当前状态（在等什么、下次先看什么），每次覆盖。</p>`
      : `<p class="empty">秘书还没写备忘。在终端用 atrium memo edit 写当前在等什么、下次先看什么。</p>`;
  if (!l.memo)
    return `<p class="empty">备忘是空的。它每次被叫醒先读这里，处理完把在等什么、下次先看什么写进来。</p>`;
  return `<div class="memo">${esc(l.memo)}</div>
    <p class="foot">${esc(at)}它每次被叫醒先读这份备忘，处理完再改写。</p>`;
}

/** 展开与检索：每次多看 50 条，至多 200 条，再往前按关键词查。 */
const decisionView = { q: "", limit: 50 };
function decisionLinks(d) {
  const links = [
    d.issue === null ? "" : chip(`#${d.issue}`, "soft"),
    ...d.nodes.map((n) => chipLink(n.name ?? n.ref, "soft", nodeHref(n.ref))),
    d.task ? chip(d.task, "soft") : "",
  ].filter(Boolean);
  return links.length ? `<span class="chips">${links.join("")}</span>` : "";
}
function decisionRow(d, l) {
  const links = decisionLinks(d);
  const fate = d.superseded_by
    ? chip(`已被 ${d.superseded_by} 推翻`, "gray")
    : d.supersedes.length
      ? chip(`推翻 ${d.supersedes.join("、")}`, "amber")
      : "";
  const gone = d.superseded_by;
  const by = who(d.by);
  return `<div class="row${gone ? " gone" : ""}" role="row">
        ${cell("日期", `${esc(d.date.slice(5))}<span class="task-ref">${esc(d.ref)}</span>`, " muted date")}
        ${cell("决定与原因", `<span class="decision">${esc(d.text)}${fate ? ` ${fate}` : ""}</span><span class="why">${esc(d.why)}</span>`, " body")}
        ${cell("谁定的", chip(by, "amber"))}
        ${cell("关联", links || none, links ? "" : " none")}
      </div>`;
}
const DECISION_HEADS = ["日期", "决定与原因", "谁定的", "关联"];
const drawDecisions = (d) => drawDecisionPage(d, null);
function drawDecisionPage(d, l) {
  const p = d.decisionPage;
  const q = decisionView.q;
  const form = `<form class="decision-search" data-decision-search role="search">
      <input name="q" type="search" placeholder="按关键词查（决定与原因，空格隔开须全部命中）" value="${esc(q)}" maxlength="200" aria-label="关键词">
      <button type="submit">查</button>${q ? `<button type="button" data-decision-clear>清掉</button>` : ""}
    </form>`;
  if (!p) return `${form}<p class="empty">正在读取…</p>`;
  const more = p.next_before
    ? decisionView.limit < 200
      ? `<p class="foot"><button type="button" class="more-button" data-decision-more>再看 50 条</button></p>`
      : `<p class="foot">更早的请按关键词查。</p>`
    : "";
  return `${form}${table(
    "decisions",
    DECISION_HEADS,
    p.decisions.map((x) => decisionRow(x, l)),
    q
      ? `没有含「${q}」的决定。`
      : "还没有决定记录。你拍板的事由秘书在终端用 atrium decision add 记下。",
  )}${more}`;
}

const EVENT_STATE = {
  waiting: ["等它处理", "amber"],
  doing: ["在处理", "green"],
  done: ["处理完", "gray"],
  handed_off: ["转交上级", "orange"],
};
function drawLeaderEvents({ leader: l }) {
  return table(
    "events",
    ["时间", "任务", "什么事", "说明", "结果"],
    l.events.map((e) => {
      const [label, tone] = EVENT_STATE[e.state] ?? EVENT_STATE.done;
      const why = [e.from ? `${e.from.name}交上来的` : "", e.why ?? ""]
        .filter(Boolean)
        .join(" · ");
      return `<div class="row" role="row">
        ${cell("时间", esc(clock(e.at)), " muted")}
        ${cell("任务", e.task ? taskName(e.task.ref, e.task.title) : `<span class="muted">不关联任务</span>`, " name plain task")}
        ${cell("什么事", chip(e.what, "soft"))}
        ${cell("说明", why ? `<span class="clamp" title="${esc(why)}">${esc(why)}</span>` : none, why ? " note" : " note none")}
        ${cell("结果", chip(label, tone))}
      </div>`;
    }),
    "还没有事交给它。它负责的部门里任务有了结果（完成、失败、卡住、上线），会先交给它处理。",
  );
}

function drawEscalations({ leader: l }) {
  return table(
    "escalations",
    ["时间", "类型", "任务", "说明", "交给", ""],
    l.escalations.map(
      (e) => `<div class="row" role="row">
        ${cell("时间", esc(clock(e.at)), " muted")}
        ${cell("类型", chip(e.label, e.kind === "shipped" ? "green" : "orange"))}
        ${cell("任务", e.task ? taskName(e.task.ref, e.task.title) : none, e.task ? " name plain task" : " none")}
        ${cell("说明", e.note ? `<span class="clamp" title="${esc(e.note)}">${esc(e.note)}</span>` : none, e.note ? " note" : " note none")}
        ${cell("交给", esc(e.to.name), " muted tagged")}
        ${cell("", e.seen ? `<span class="muted small">已看</span>` : chip("还没看", "amber"))}
      </div>`,
    ),
    "还没上交过。只有已上线、要别的部门配合、越权、搞不定这四类事才交给上级。",
  );
}

// ---- 页签：加一个页签只加一项。count 显示在名字旁的小圆标里。 ----

const TABS = {
  parts: {
    label: "下属部门",
    count: (d) => liveParts(d.node).length,
    draw: drawParts,
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
    label: "专员",
    count: (d) => (d.team ?? []).length,
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
        : d.org.workers.pending
          ? null
          : new Set(d.org.workers.rows.map((w) => w.worker)).size,
    draw: (d) => (d.page === "role" ? drawRoleWorkers(d) : drawWorkers(d)),
  },
  points: {
    label: "要点",
    count: (d) => allPoints(d.node).length,
    draw: drawPoints,
  },
  choices: {
    label: "选项",
    count: (d) => openChoices(d.node).length || null,
    draw: drawChoices,
  },
  materials: {
    label: "资料",
    count: (d) => liveMaterials(d.node).length,
    draw: drawMaterials,
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
  leaders: {
    label: "负责人",
    count: (d) => d.org.leaders.length,
    draw: drawLeaders,
  },
  memo: { label: "备忘", count: () => null, draw: drawMemo },
  decisions: {
    label: "决定记录",
    count: (d) => d.decisionPage?.active ?? null,
    draw: drawDecisions,
  },
  events: {
    label: "处理过的事",
    count: (d) => d.leader.events.length,
    draw: drawLeaderEvents,
  },
  escalations: {
    label: "上交",
    count: (d) => d.leader.escalations.length,
    draw: drawEscalations,
  },
};
/** 这一页有哪些页签（第一个是默认）；专员页的「执行者」叫「谁做得好」。 */
function tabsOf(d) {
  if (d.page === "role") return ["tasks", "workers", "skills"];
  if (d.page === "worker") return ["deliveries", "notes"];
  if (d.page === "leader")
    return d.leader.kind === "user"
      ? ["decisions"]
      : isSecretary(d.leader)
        ? ["memo"]
        : ["memo", "events", "escalations"];
  const decided = ["decisions"];
  if (d.org)
    return [
      "parts",
      "choices",
      "leaders",
      "roles",
      "skills",
      "workers",
      "points",
      ...((d.node.materials ?? []).length ? ["materials"] : []),
      ...decided,
    ];
  return [
    "parts",
    ...((d.node.choices ?? []).length ? ["choices"] : []),
    "tasks",
    "points",
    ...((d.node.materials ?? []).length ? ["materials"] : []),
    ...decided,
  ];
}
const tabLabel = (d, id) =>
  d.page === "role" && id === "workers"
    ? "谁做得好"
    : d.page === "node" && id === "decisions"
      ? "决定"
      : TABS[id].label;

// ---- 页头：小字类别、标题、属性行、介绍 ----

const KIND = { org: "组织", project: "部门", module: "部门" };
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
  if (d.page === "leader" && d.leader.kind === "user")
    return {
      kind: "用户",
      name: "你",
      props: "",
      intro: [
        "你拍板的事与原因：只给人回看，不附进任何提示词；要大家守的规矩在各块的「要点」里。可按关键词查。",
      ],
    };
  if (d.page === "leader" && isSecretary(d.leader))
    return {
      kind: "秘书",
      name: "秘书",
      props: "",
      intro: [
        "替你把目标补成简报、拆活、派给负责人和执行者，只把要你拍板的事递上来。这里是它留给自己的备忘，换机器、换秘书都接得上。",
      ],
    };
  if (d.page === "role") {
    const r = d.role;
    return {
      kind: "专员",
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
          "接过的专员",
          chips(
            w.stats.filter((s) => s.role).map((s) => chip(s.role, "role")),
            "还没有",
          ),
        ],
      ]),
      intro: [],
    };
  }
  if (d.page === "leader") {
    const l = d.leader;
    return {
      kind: "负责人",
      name: l.name,
      props: props([
        [
          "负责",
          chips(
            l.nodes.map((n) => chipLink(title(n), "soft", nodeHref(n.ref))),
            "还没指派",
          ),
        ],
        ["现在", leadState(l, true)],
        ["执行者", chip(workerLabel(l.worker), "soft")],
      ]),
      intro: [
        "替你管上面这几块：这里的任务有了结果先交给它，它派活、盯进度、收结果；只有已上线、要别的部门配合、越权、搞不定这四类事才交给上级。",
      ],
    };
  }
  const n = d.node;
  // 组织根另给「秘书」一行，点开是秘书的备忘与决定记录。
  const people = [
    ...(d.org
      ? [
          ["秘书", chipLink("秘书", "leader", leaderHref("secretary"))],
          ["你的决定", chipLink("你拍板的", "leader", leaderHref("u1"))],
        ]
      : []),
    ...(n.lead ? [["负责人", leadProp(n.lead)]] : []),
  ];
  return {
    kind: KIND[n.kind] ?? "部门",
    name: title(n),
    props: people.length ? props(people) : "",
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
  if (d.page === "leader")
    return d.leader.kind === "user"
      ? [...top, { name: "你" }]
      : isSecretary(d.leader)
        ? [...top, { name: "秘书" }]
        : [
            ...top,
            { name: "负责人", url: nodeHref(root?.ref, "leaders") },
            { name: d.leader.name },
          ];
  return d.page === "role"
    ? [
        ...top,
        { name: "专员", url: nodeHref(root?.ref, "roles") },
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
  if (state.mode === "expired" || state.mode === "forbidden") {
    live.dataset.state = "off";
    live.textContent =
      state.mode === "expired" ? "登录已失效" : "数据接口未开放";
  } else if (live.dataset.state === "down") {
    live.textContent = "已断开，重连中";
  } else if (state.now) {
    const busy = state.now.leaders ?? [];
    // 在跑数看当前部门（含下属部门）；角色页与执行者页没有所属部门，退回全组织。
    const text = liveText(state.route.page, state.data, state.now);
    live.dataset.state = text !== "都停着" || busy.length ? "on" : "idle";
    // 窄屏顶栏放不下名字，只说「负责人在处理」，不挤掉面包屑。
    const narrow = matchMedia("(max-width: 720px)").matches;
    const lead = busy.length
      ? `${busy.length > 1 ? `${busy.length} 位负责人` : narrow ? "负责人" : busy[0].name}在处理`
      : "";
    live.textContent =
      text === "都停着"
        ? lead || "都停着"
        : [text, lead].filter(Boolean).join(" · ");
    live.title = busy.map((l) => `${l.name}：${l.doing ?? ""}`).join("\n");
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
    "找不到这个专员",
    `链接里的 <code>${esc(ref)}</code> 不存在，可能已经删掉了。`,
  ],
  leader: (ref) => [
    "找不到这位负责人",
    `链接里的 <code>${esc(ref)}</code> 没有登记。`,
  ],
  // 服务端说得清原因（名字不合法，或没有交付记录也没有档案），照着说。
  worker: (ref, why) => [
    "找不到这个执行者",
    why ? `${esc(why)}。` : `<code>${esc(ref)}</code> 不存在。`,
  ],
};

const badge = (n) => (n === null ? "" : `<span class="badge">${n}</span>`);

function pageHtml() {
  const rootLink = state.root
    ? `<a href="${esc(nodeHref(state.root.ref))}">回到最上层</a>`
    : "";
  if (state.mode === "expired")
    return notice(
      "全景网页的登录已失效",
      "在终端运行 <code>atrium map</code>，会重新打开一个登录链接。",
    );
  if (state.mode === "forbidden")
    return notice(
      "这个页面的数据接口没开放给网页",
      "Atrium 的问题，不是你的登录。",
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
      <span>${esc(tabLabel(d, id))}</span>${badge(TABS[id].count(d))}
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
  // 组织根页顶部：还有选项单等你拍板就给一个入口，点进「选项」页签。
  const waiting = d.org ? (state.now?.choices?.open ?? 0) : 0;
  const decideLink =
    waiting && tab !== "choices"
      ? `<a class="decide-banner" href="${esc(href(page, at, "choices"))}"><span class="decide-mark" aria-hidden="true">✱</span>等你拍板：${waiting}<span class="decide-go">去看</span></a>`
      : "";
  return `${decideLink}<header class="intro">
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
    const saved = formState();
    $("page").innerHTML = html;
    restoreForms(saved);
  }
  const d = state.mode === "ok" ? state.data : null;
  document.title = d ? `${heading(d).name} · Atrium 全景` : "Atrium 全景";
}

// ---- 路由与刷新 ----

function fail(error) {
  if (error instanceof Expired) {
    state.mode = "expired";
    document.body.classList.add("expired");
  } else if (error instanceof Forbidden) {
    state.mode = "forbidden";
  } else {
    $("live").dataset.state = "down";
    if (!state.data) state.mode = "down";
  }
  draw();
}

/** 取一页的数据；在看决定时另取列表（关键词、条数在 decisionView）。 */
async function fetchPage(route, key) {
  const data = await fetchBase(route, key);
  // 用户页（#u1）只有「决定记录」一个页签，缺省就是它。
  const decisions =
    route.tab === "decisions" || (route.page === "leader" && key === "u1");
  if (!decisions) return data;
  const query = new URLSearchParams({
    of: key,
    all: "1",
    limit: String(decisionView.limit),
  });
  if (decisionView.q) query.set("q", decisionView.q);
  return { ...data, decisionPage: await get(`/decisions?${query}`) };
}

/** 取一页的数据；组织根另带专员、技能、执行者。 */
async function fetchBase(route, key) {
  if (route.page === "role")
    return {
      page: "role",
      role: await get(`/specialists/${encodeURIComponent(key)}`),
    };
  if (route.page === "worker")
    return {
      page: "worker",
      worker: await get(`/workers/${encodeURIComponent(route.ref)}`),
    };
  if (route.page === "leader")
    return {
      page: "leader",
      leader: await get(`/leaders/${encodeURIComponent(key)}`),
    };
  if (key !== state.root.ref)
    return {
      page: "node",
      node: await get(`/nodes/${encodeURIComponent(key)}`),
    };
  return keepWorkers(await fetchRootOrg(get, key), state.cache.get(key));
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
    if (data.page === "node" && data.org) fillWorkers(seq, key);
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

function fillWorkers(seq, key) {
  get("/workers")
    .then((workers) => {
      if (seq !== state.seq) return;
      const data = state.cache.get(key);
      if (!data) return;
      const next = withWorkers(data, workers);
      state.cache.set(key, next);
      if (pageKey(state.route, state.root.ref) === key) {
        state.data = next;
        if (state.mode === "ok") draw();
      }
    })
    .catch((error) => {
      if (seq !== state.seq) return;
      if (error instanceof Expired || error instanceof Forbidden) fail(error);
    });
}

async function refresh() {
  if (state.mode === "expired") return;
  try {
    const nowP = get("/now").then((now) => {
      state.now = now;
      if ($("live").dataset.state === "down") $("live").dataset.state = "on";
    });
    await Promise.all([nowP, load()]);
  } catch (error) {
    fail(error);
  }
}

function subscribe() {
  const source = new EventSource("/api/map/stream");
  let greeted = false;
  source.addEventListener("hello", () => {
    $("live").dataset.state = "on";
    if (sseReloadOnHello(greeted)) refresh();
    greeted = true;
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

window.addEventListener("hashchange", () => {
  decisionView.q = "";
  decisionView.limit = 50;
  load(true).catch(fail);
});
$("page").addEventListener("submit", (event) => {
  const search = event.target.closest("form[data-decision-search]");
  if (search) {
    event.preventDefault();
    decisionView.q = search.elements.q.value.trim();
    decisionView.limit = 50;
    load().catch(fail);
    return;
  }
  const form = event.target.closest("form[data-choice]");
  if (!form) return;
  event.preventDefault();
  decide(form, event.submitter?.value === "pass" ? "pass" : "pick");
});
$("page").addEventListener("click", (event) => {
  if (event.target.closest("[data-decision-more]")) {
    decisionView.limit = Math.min(200, decisionView.limit + 50);
    load().catch(fail);
  } else if (event.target.closest("[data-decision-clear]")) {
    decisionView.q = "";
    decisionView.limit = 50;
    load().catch(fail);
  }
});
await refresh();
if (state.mode !== "expired") subscribe();
// 执行者的最近动作与「用时」不改账本，隔一会儿重取一次。
setInterval(() => {
  if (!document.hidden) refresh();
}, 30000);
