// Atrium 全景网页：只读。数据来自与 `atrium map --json` 相同的接口，
// 订阅 /api/map/stream 的失效通知，变了只重取并重画，不整页重载。
// 一块一页：面包屑 → 大标题与介绍 → 页签（组成部分／专员／任务／原则）。
// 当前块、页签与任务筛选写在地址的 hash 里（#o2/tasks/all），刷新与前进后退都回到原处。

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
  node: null,
  now: null,
  /** 看过的块先用旧数据画出来，再换新的，切换时不闪白。 */
  cache: new Map(),
  route: { ref: null, tab: "parts", show: "active" },
  /** 页面的整体状态：ok / missing（链接里的块不存在）/ empty（没有组织树）/ down / expired。 */
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
  if (response.status === 404) throw new Missing();
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

// ---- 地址 ----

const TAB_IDS = ["parts", "concerns", "tasks", "points"];
function parseRoute() {
  const [ref, tab, show] = location.hash.slice(1).split("/");
  return {
    ref: /^o[1-9]\d{0,8}$/.test(ref ?? "") ? ref : null,
    tab: TAB_IDS.includes(tab) ? tab : "parts",
    show: tab === "tasks" && show === "all" ? "all" : "active",
  };
}
const href = (ref, tab = "parts", show = "active") =>
  `#${ref}${tab === "parts" ? "" : `/${tab}`}${tab === "tasks" && show === "all" ? "/all" : ""}`;

// ---- 人话 ----

function duration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "不到 1 分钟";
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}
const title = (n) => n.alias || n.name;
const workerName = (w) => (w ? w.split(/[+:]/)[0] : "");
const who = (by) => String(by ?? "").replace(/^u1\b/, "你");
const isPathRule = (rule) => /[/*?]|^\./.test(rule);

const ICON = {
  part: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>`,
  concern: `<svg class="icon icon-concern" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/></svg>`,
  point: `<svg class="icon icon-point" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/></svg>`,
  go: `<svg class="icon icon-go" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`,
};
const chip = (text, tone) =>
  `<span class="chip chip-${tone}">${esc(text)}</span>`;
const cell = (label, body, extra = "") =>
  `<span class="cell${extra}" role="cell" data-label="${esc(label)}">${body}</span>`;
const table = (kind, heads, rows, empty) =>
  `<div class="table table-${kind}" role="table">
    <div class="row head" role="row">${heads.map((h) => `<span role="columnheader">${esc(h)}</span>`).join("")}</div>
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
  done: ["完成", "gray"],
  failed: ["失败", "red"],
  cancelled: ["取消", "gray"],
};
const ACTIVE = new Set(["doing", "merge", "blocked", "queued"]);
const ORDER = Object.keys(TAG);
function tagOf(t) {
  if (t.delivery_stage === "merge_queued" || t.delivery_stage === "merging")
    return "merge";
  if (t.delivery_stage === "merged" || t.delivery_stage === "online")
    return "merged";
  if (t.status === "running") return "doing";
  if (t.status === "todo") return t.queued ? "queued" : "todo";
  return TAG[t.status] ? t.status : "done";
}
function taskList(n) {
  const { running, blocked, todo, recent } = n.tasks;
  return [...running, ...blocked, ...todo, ...recent]
    .map((t) => ({ ...t, tag: tagOf(t) }))
    .sort((a, b) => ORDER.indexOf(a.tag) - ORDER.indexOf(b.tag));
}
function spent(t) {
  if (!t.started_at) return "";
  const end =
    t.ended_at ?? (t.status === "running" ? Date.now() : t.updated_at);
  return duration(end - t.started_at);
}

// ---- 各页签 ----

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

function drawParts(n) {
  return table(
    "parts",
    ["名称", "做什么", "状态", "下面", ""],
    liveParts(n).map(
      (p) => `<a class="row link" role="row" href="${esc(href(p.ref))}">
        ${cell("名称", `${ICON.part}<span>${esc(title(p))}</span>`, " name")}
        ${cell("做什么", p.what ? esc(p.what) : `<span class="muted">还没写</span>`, " text")}
        ${cell("状态", partState(p))}
        ${cell("下面", p.parts ? `${p.parts} 块` : "—", p.parts ? " muted" : " muted none")}
        ${cell("", ICON.go, " go")}
      </a>`,
    ),
    "这一块没有再往下分。",
  );
}

function inviteText(rules) {
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

function drawConcerns(n) {
  return table(
    "concerns",
    ["专员", "盯什么", "什么时候请来", "现在", ""],
    liveConcerns(n).map(
      (q) => `<a class="row link" role="row" href="${esc(href(q.ref))}">
        ${cell("专员", `${ICON.concern}<span>${esc(title(q))}</span>`, " name")}
        ${cell("盯什么", q.what ? esc(q.what) : `<span class="muted">还没写</span>`, " text")}
        ${cell("什么时候请来", inviteText(q.invite_when ?? []), " note")}
        ${cell("现在", q.watching ? chip(`在盯 ${q.watching} 件`, "purple") : chip("没被请", "gray"))}
        ${cell("", ICON.go, " go")}
      </a>`,
    ),
    "这一块还没有专员。",
  );
}

function drawTasks(n) {
  const all = taskList(n);
  const list =
    state.route.show === "all" ? all : all.filter((t) => ACTIVE.has(t.tag));
  return table(
    "tasks",
    ["任务", "状态", "谁在做", "用时", "最近在做"],
    list.map((t) => {
      const [label, tone] = TAG[t.tag];
      const worker = workerName(t.worker);
      const doing = t.action || t.reason || "";
      return `<div class="row" role="row">
        ${cell("任务", `<span title="${esc(t.ref)}">${esc(t.title)}</span>`, " name plain")}
        ${cell("状态", chip(label, tone))}
        ${cell("谁在做", worker ? chip(worker, "soft") : `<span class="muted">—</span>`, worker ? "" : " none")}
        ${cell("用时", spent(t) || "—", spent(t) ? " muted" : " muted none")}
        ${cell("最近在做", doing ? `<span class="clamp" title="${esc(doing)}">${esc(doing)}</span>` : `<span class="muted">—</span>`, doing ? " note" : " note none")}
      </div>`;
    }),
    state.route.show === "all"
      ? "这一块还没有任务。"
      : "现在没有进行中的任务。",
  );
}

function drawPoints(n) {
  return table(
    "points",
    ["原则", "为什么", "谁定的", "来自"],
    allPoints(n).map(
      (p) => `<div class="row" role="row">
        ${cell("原则", `${ICON.point}<span>${esc(p.text)}</span>`, " name plain")}
        ${cell("为什么", esc(p.why), " note")}
        ${cell("谁定的", chip(who(p.by), "amber"))}
        ${cell("来自", p.from ? `<a href="${esc(href(p.from.ref))}">${esc(p.from.name)}</a>` : "这一块", " muted")}
      </div>`,
    ),
    "这一块还没写原则。",
  );
}

/** 页签：加一个页签只加一项。count 显示在名字旁的小圆标里。 */
const TABS = [
  {
    id: "parts",
    label: "组成部分",
    count: (n) => liveParts(n).length,
    draw: drawParts,
  },
  {
    id: "concerns",
    label: "专员",
    count: (n) => liveConcerns(n).length,
    draw: drawConcerns,
  },
  {
    id: "tasks",
    label: "任务",
    count: (n) => taskList(n).filter((t) => ACTIVE.has(t.tag)).length,
    draw: drawTasks,
  },
  {
    id: "points",
    label: "原则",
    count: (n) => allPoints(n).length,
    draw: drawPoints,
  },
];

// ---- 画 ----

function drawCrumbs() {
  const n = state.mode === "ok" ? state.node : null;
  const chain = n
    ? n.chain
    : state.root
      ? [
          {
            ref: state.root.ref,
            name: state.root.name,
            alias: state.root.alias,
          },
        ]
      : [];
  const html = chain
    .map((c, i) =>
      i === chain.length - 1 && n
        ? `<span class="crumb current" aria-current="page">${esc(title(c))}</span>`
        : `<a class="crumb" href="${esc(href(c.ref))}">${esc(title(c))}</a>`,
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

function pageHtml() {
  const rootLink = state.root
    ? `<a href="${esc(href(state.root.ref))}">回到最上层</a>`
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
  if (state.mode === "missing")
    return notice(
      "找不到这一块",
      `链接里的 <code>${esc(state.missing)}</code> 不存在，可能已经删掉了。${rootLink}`,
    );
  if (state.mode === "down" || !state.node)
    return notice(
      state.mode === "down" ? "暂时取不到数据" : "正在读取…",
      state.mode === "down" ? "服务可能在重启，页面会自己重试。" : "",
    );
  const n = state.node;
  const { tab, show } = state.route;
  const intro = (n.overview.what || "")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const tabs = TABS.map(
    (
      t,
    ) => `<a class="tab" role="tab" href="${esc(href(n.ref, t.id))}" aria-selected="${t.id === tab}">
      <span>${esc(t.label)}</span><span class="badge">${t.count(n)}</span>
    </a>`,
  ).join("");
  const filters =
    tab === "tasks"
      ? `<div class="filters" aria-label="筛选">${[
          ["active", "进行中"],
          ["all", "全部"],
        ]
          .map(
            ([id, label]) =>
              `<a class="filter" href="${esc(href(n.ref, "tasks", id))}" aria-current="${id === show}">${label}</a>`,
          )
          .join("")}</div>`
      : "";
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  return `<header class="intro">
      <h1>${esc(title(n))}</h1>
      ${intro.length ? intro.map((p) => `<p>${esc(p)}</p>`).join("") : `<p class="muted">这一块还没写是做什么的。</p>`}
    </header>
    <section class="view">
      <div class="tabbar"><div class="tabs" role="tablist" aria-label="视图">${tabs}</div>${filters}</div>
      <div role="tabpanel">${current.draw(n)}</div>
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
  document.title =
    state.mode === "ok" && state.node
      ? `${title(state.node)} · Atrium 全景`
      : "Atrium 全景";
}

// ---- 路由与刷新 ----

function fail(error) {
  if (error instanceof Expired) {
    state.mode = "expired";
    document.body.classList.add("expired");
  } else {
    $("live").dataset.state = "down";
    if (!state.node) state.mode = "down";
  }
  draw();
}

/** 取当前地址对应的块；move 为 true 表示换了块（滚回顶部、焦点给正文）。 */
async function load(move = false) {
  const seq = ++state.seq;
  const route = parseRoute();
  const changed = route.ref !== state.route.ref;
  state.route = route;
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
  const ref = route.ref ?? state.root.ref;
  // 切到看过的块：先用上次的数据画，不留白。
  if (changed && state.cache.has(ref)) {
    state.node = state.cache.get(ref);
    state.mode = "ok";
    draw();
  } else if (!changed && state.node?.ref === ref) draw();
  try {
    const node = await get(`/nodes/${encodeURIComponent(ref)}`);
    if (seq !== state.seq) return;
    state.cache.set(ref, node);
    state.node = node;
    state.mode = "ok";
  } catch (error) {
    if (seq !== state.seq) return;
    if (!(error instanceof Missing)) throw error;
    state.mode = "missing";
    state.missing = ref;
    state.node = null;
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
