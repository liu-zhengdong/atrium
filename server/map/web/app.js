// Atrium 全景网页（#322 第 4 步）：只读。数据来自与 `atrium map --json` 相同的接口，
// 订阅 /api/map/stream 的失效通知，变了只重取并重画变化的区域，不整页重载。

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const OPEN_KEY = "atrium-map-open";
const state = {
  tree: null,
  root: null,
  node: null,
  now: null,
  selected: null,
  open: new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || "[]")),
  byRef: new Map(),
  parentOf: new Map(),
  drawn: { tree: "", now: "", detail: "" },
};

// ---- 取数据 ----

class Expired extends Error {}
async function get(path) {
  const response = await fetch(`/api/map${path}`, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (response.status === 401) throw new Expired();
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function expired() {
  $("live").dataset.state = "off";
  $("live").textContent = "登录已失效";
  document.body.classList.add("expired");
  $("detail").innerHTML =
    `<div class="empty"><h1>全景网页的登录已失效</h1><p>在终端运行 <code>atrium map</code>，会重新打开一个登录链接。</p></div>`;
}

// ---- 时间与人话 ----

function duration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "不到 1 分钟";
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
}
const ago = (at) => (at ? `${duration(Date.now() - at)}前` : "");
const title = (n) => (n.alias && n.alias !== n.name ? n.alias : n.name);
const subtitle = (n) => (n.alias && n.alias !== n.name ? n.name : "");
const DOT_LABEL = {
  running: "有任务在跑",
  blocked: "有任务卡住",
  idle: "没有在跑的任务",
};
const dot = (kind) =>
  `<span class="dot dot-${esc(kind)}" role="img" aria-label="${DOT_LABEL[kind] ?? ""}"></span>`;
const workerName = (w) => (w ? w.split(/[+:]/)[0] : "");

// ---- 顶部：现在在推进什么 ----

function taskLine(t) {
  const meta = [
    t.queued ? "排队中" : "",
    workerName(t.worker),
    t.started_at && !t.queued
      ? `跑了 ${duration(Date.now() - t.started_at)}`
      : "",
  ].filter(Boolean);
  const action = t.action
    ? `<span class="action">${esc(t.action)}${t.log_at ? ` · ${ago(t.log_at)}` : ""}</span>`
    : t.reason
      ? `<span class="action">${esc(t.reason)}</span>`
      : "";
  return `<li class="task">
    <div class="task-head"><span class="ref">${esc(t.ref)}</span><span class="task-title">${esc(t.title)}</span></div>
    <div class="task-meta">${meta.map(esc).join(" · ")}${action ? `${meta.length ? " · " : ""}${action}` : ""}</div>
  </li>`;
}

function drawNow() {
  const now = state.now;
  if (!now) return;
  const total = now.running + now.queued;
  const html = total
    ? `<div class="now-head"><h2>现在在推进什么</h2><span class="muted">在跑 ${now.running}${now.queued ? ` · 排队 ${now.queued}` : ""}${now.blocked ? ` · <span class="warn">卡住 ${now.blocked}</span>` : ""}</span></div>
      <div class="now-groups">${now.groups
        .map(
          (g) => `<section class="now-group">
            <h3>${g.part ? `<a href="#${esc(g.part.ref)}">${esc(title(g.part))}</a>` : "未归属"}</h3>
            <ul class="tasks">${g.tasks.map((t) => taskLine(t)).join("")}</ul>
          </section>`,
        )
        .join("")}</div>`
    : `<div class="now-head"><h2>现在在推进什么</h2><span class="muted">没有在跑的任务${now.blocked ? ` · <span class="warn">卡住 ${now.blocked}</span>` : ""}</span></div>`;
  if (html === state.drawn.now) return;
  state.drawn.now = html;
  $("now").innerHTML = html;
}

// ---- 左：全景树 ----

function index(node, parent) {
  state.byRef.set(node.ref, node);
  if (parent) state.parentOf.set(node.ref, parent.ref);
  for (const child of node.children ?? []) index(child, node);
}

function treeRow(node, level) {
  const kids = (node.children ?? []).filter((c) => !c.archived);
  const open =
    level === 0 || state.open.has(node.ref) || state.selected === node.ref;
  const selected = state.selected === node.ref;
  const count = node.tasks.running
    ? `<span class="count">在跑 ${node.tasks.running}</span>`
    : node.tasks.blocked
      ? `<span class="count warn">卡住 ${node.tasks.blocked}</span>`
      : "";
  const caret = kids.length
    ? `<button class="caret" data-toggle="${esc(node.ref)}" aria-label="${open ? "折叠" : "展开"}" aria-expanded="${open}"></button>`
    : `<span class="caret-space"></span>`;
  return `<li role="treeitem" aria-expanded="${kids.length ? open : ""}" aria-selected="${selected}">
    <div class="row${selected ? " selected" : ""}" style="--level:${level}">
      ${caret}<a href="#${esc(node.ref)}" class="row-link">${dot(node.dot)}<span class="row-name">${esc(title(node))}</span>${count}</a>
    </div>
    ${kids.length && open ? `<ul role="group">${kids.map((c) => treeRow(c, level + 1)).join("")}</ul>` : ""}
  </li>`;
}

function drawTree() {
  if (!state.tree) return;
  const html = treeRow(state.tree, 0);
  if (html === state.drawn.tree) return;
  state.drawn.tree = html;
  $("tree").innerHTML = html;
}

$("tree").addEventListener("click", (event) => {
  const button = event.target.closest("[data-toggle]");
  if (!button) return;
  event.preventDefault();
  const ref = button.dataset.toggle;
  if (state.open.has(ref)) state.open.delete(ref);
  else state.open.add(ref);
  localStorage.setItem(OPEN_KEY, JSON.stringify([...state.open]));
  drawTree();
});

// ---- 右：选中的一块 ----

function section(label, body, extra = "") {
  return body
    ? `<section class="block${extra}"><h2>${esc(label)}</h2>${body}</section>`
    : "";
}
const unwritten = (what) => `<p class="unwritten">${esc(what)}还没写</p>`;

function checkLink(check, repoUrl) {
  if (!check) return "";
  const file = /^(tests\/[\w./-]+\.ts)/.exec(check);
  const text = `<code>${esc(check)}</code>`;
  return file && repoUrl
    ? `<a href="${esc(`${repoUrl}/blob/main/${file[1]}`)}" target="_blank" rel="noreferrer">${text}</a>`
    : text;
}

function point(p, repoUrl) {
  return `<li class="point">
    <p class="point-text">${esc(p.text)}</p>
    <p class="point-meta">为什么：${esc(p.why)}<span class="sep">·</span>${esc(p.by)} 定${p.check ? `<span class="sep">·</span>检查 ${checkLink(p.check, repoUrl)}` : ""}</p>
  </li>`;
}

const STAGE = {
  planned: "规划中",
  active: "进行中",
  achieved: "达成",
  blocked: "受阻",
  dropped: "放弃",
};

function partRow(p) {
  const tree = state.byRef.get(p.ref);
  const counts = [
    p.tasks.running ? `在跑 ${p.tasks.running}` : "",
    p.tasks.blocked ? `<span class="warn">卡住 ${p.tasks.blocked}</span>` : "",
    p.tasks.todo ? `待办 ${p.tasks.todo}` : "",
  ].filter(Boolean);
  return `<li><a class="part" href="#${esc(p.ref)}">
    <span class="part-head">${dot(tree?.dot ?? (p.tasks.running ? "running" : "idle"))}<span class="part-name">${esc(title(p))}</span>${p.analogy ? `<span class="analogy">${esc(p.analogy)}</span>` : ""}<span class="part-count">${counts.join(" · ")}</span></span>
    ${tree?.what ? `<span class="part-what">${esc(tree.what)}</span>` : ""}
  </a></li>`;
}

const prList = (prs) =>
  prs.length
    ? `<ul class="plain links">${prs.map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noreferrer">PR #${esc(p.url.split("/").pop())}</a> <span class="muted">${esc(p.title)}（${esc(p.task)}）</span></li>`).join("")}</ul>`
    : "";

function drawDetail() {
  const n = state.node;
  if (!n) return;
  const o = n.overview;
  const crumbs = n.chain
    .map((c, i) =>
      i === n.chain.length - 1
        ? `<span aria-current="page">${esc(title(c))}</span>`
        : `<a href="#${esc(c.ref)}">${esc(title(c))}</a>`,
    )
    .join(`<span class="sep">/</span>`);
  const parts = o.parts.filter((p) => !p.archived);
  const ownPoints = n.points;
  const upperPoints = n.points_chain.flatMap((l) =>
    l.points.map((p) => ({ ...p, from: l.name })),
  );
  const tasks = n.tasks;
  const live = [...tasks.running, ...tasks.blocked];
  const html = `
    <nav class="crumbs" aria-label="位置">${crumbs}</nav>
    <header class="head">
      <h1>${esc(title(n))}${subtitle(n) ? `<span class="aka">${esc(subtitle(n))}</span>` : ""}</h1>
      ${n.analogy ? `<p class="head-analogy">${esc(n.analogy)}</p>` : ""}
      <p class="lead">${o.what ? esc(o.what) : `<span class="unwritten">是什么还没写</span>`}</p>
    </header>
    ${section(
      "能用它做什么",
      o.uses.length
        ? `<ul class="bullets">${o.uses.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>`
        : "",
    )}
    ${section(
      "一件事怎么走完",
      o.flow.length
        ? `<ol class="flow">${o.flow.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`
        : "",
    )}
    ${section(
      "由哪几部分组成",
      parts.length
        ? `<ul class="parts">${parts.map(partRow).join("")}</ul>`
        : "",
    )}
    ${section(
      "要点",
      ownPoints.length || upperPoints.length
        ? `${ownPoints.length ? `<ul class="points">${ownPoints.map((p) => point(p, n.detail.repo_url)).join("")}</ul>` : `<p class="unwritten">这一块自己还没有要点</p>`}
           ${upperPoints.length ? `<details class="inherit"><summary>上级的要点 ${upperPoints.length} 条，也要守住</summary><ul class="points">${upperPoints.map((p) => point({ ...p, by: `${p.by}（${p.from}）` }, n.detail.repo_url)).join("")}</ul></details>` : ""}`
        : "",
    )}
    ${section(
      "现在做到哪",
      o.now || o.next || o.stages.length
        ? `${o.now ? `<p>${esc(o.now)}</p>` : unwritten("现状")}
           ${o.next ? `<p class="next"><span class="label">接下来</span>${esc(o.next)}</p>` : ""}
           ${o.stages.length ? `<ul class="stages">${o.stages.map((s) => `<li class="stage stage-${esc(s.status)}"><span class="chip">${STAGE[s.status] ?? esc(s.status)}</span><span>${esc(s.result)}</span>${s.due ? `<span class="muted">${esc(s.due)}</span>` : ""}</li>`).join("")}</ul>` : ""}`
        : "",
    )}
    ${section(
      "正在推进",
      live.length || tasks.todo.length
        ? `${live.length ? `<ul class="tasks">${live.map((t) => taskLine(t)).join("")}</ul>` : `<p class="muted">现在没有在跑的任务</p>`}
           ${tasks.todo.length ? `<details class="todo"><summary>待办 ${tasks.todo.length}${n.counts.open - n.counts.running - n.counts.blocked > tasks.todo.length ? `（共 ${n.counts.open - n.counts.running - n.counts.blocked}）` : ""}</summary><ul class="plain">${tasks.todo.map((t) => `<li><span class="ref">${esc(t.ref)}</span> ${esc(t.title)}</li>`).join("")}</ul></details>` : ""}`
        : "",
    )}
    ${section(
      "请了哪些专员",
      n.concerns.length
        ? `<ul class="parts">${n.concerns.map(partRow).join("")}</ul>`
        : "",
    )}
    ${section(
      "PR 与 issue",
      n.links.prs.length || n.links.issues.length
        ? `${n.links.issues.length ? `<p class="issues">${n.links.issues.map((i) => `<a href="${esc(i.url)}" target="_blank" rel="noreferrer">issue #${esc(i.number)}</a>`).join("")}</p>` : ""}${prList(n.links.prs.slice(0, 4))}${n.links.prs.length > 4 ? `<details class="more"><summary>更早的 PR ${n.links.prs.length - 4} 个</summary>${prList(n.links.prs.slice(4))}</details>` : ""}`
        : "",
    )}
    <details class="block tech">
      <summary>技术细节</summary>
      <dl>
        <dt>短号与路径</dt><dd><code>${esc(n.ref)}</code> <code>${esc(n.path)}</code></dd>
        <dt>负责</dt><dd>${esc(n.leader ?? "无")}</dd>
        ${n.detail.repos.length ? `<dt>仓库</dt><dd>${n.detail.repos.map((r) => `<code>${esc(r)}</code>`).join(" ")}</dd>` : ""}
        ${n.detail.rev ? `<dt>章程</dt><dd>${esc(n.detail.rev)} · ${esc(new Date(n.detail.updated_at).toLocaleString("zh-CN"))}</dd>` : ""}
      </dl>
      ${n.detail.body.trim() ? `<pre class="body">${esc(n.detail.body.trim())}</pre>` : ""}
      <p class="muted">改这一块：<code>atrium map edit ${esc(n.ref)} --what …</code></p>
    </details>`;
  if (html === state.drawn.detail) return;
  // 保留技术细节等折叠块的展开状态。
  const opened = [...$("detail").querySelectorAll("details[open]")].map(
    (d) => d.className,
  );
  state.drawn.detail = html;
  $("detail").innerHTML = html;
  for (const d of $("detail").querySelectorAll("details"))
    if (opened.includes(d.className)) d.open = true;
  document.title = `${title(n)} · Atrium 全景`;
}

// ---- 路由与刷新 ----

function selectedRef() {
  const hash = location.hash.slice(1);
  return /^o\d+$/.test(hash) ? hash : state.root;
}

async function loadNode(move = false) {
  const ref = selectedRef();
  if (!ref) return;
  const changed = ref !== state.selected;
  state.selected = ref;
  // 展开到选中的那一块。
  for (let p = state.parentOf.get(ref); p; p = state.parentOf.get(p))
    state.open.add(p);
  drawTree();
  state.node = await get(`/nodes/${encodeURIComponent(ref)}`);
  drawDetail();
  if (move && changed) {
    window.scrollTo({ top: 0 });
    $("detail").focus({ preventScroll: true });
    if (matchMedia("(max-width: 760px)").matches) $("side-toggle").open = false;
  }
}

async function refresh() {
  try {
    const [tree, now] = await Promise.all([get("/tree"), get("/now")]);
    state.tree = tree.tree;
    state.root = tree.root;
    state.byRef.clear();
    state.parentOf.clear();
    if (tree.tree) index(tree.tree, null);
    state.now = now;
    drawNow();
    if (!tree.tree) {
      $("detail").innerHTML =
        `<div class="empty"><h1>还没有组织树</h1><p>在终端运行 <code>atrium org import --repo 仓库</code>。</p></div>`;
      return;
    }
    await loadNode();
  } catch (error) {
    if (error instanceof Expired) return expired();
    $("live").dataset.state = "off";
    $("live").textContent = "取数据失败，稍后重试";
  }
}

function subscribe() {
  const source = new EventSource("/api/map/stream");
  source.addEventListener("hello", () => {
    $("live").dataset.state = "on";
    $("live").textContent = "实时";
    refresh();
  });
  source.addEventListener("changed", () => refresh());
  source.onerror = async () => {
    $("live").dataset.state = "off";
    $("live").textContent = "已断开，重连中";
    // 会话失效时 EventSource 会一直重试：先问一次，失效就停下。
    try {
      await get("/now");
    } catch (error) {
      if (error instanceof Expired) {
        source.close();
        expired();
      }
    }
  };
}

window.addEventListener("hashchange", () =>
  loadNode(true).catch((error) => {
    if (error instanceof Expired) expired();
  }),
);
if (matchMedia("(max-width: 760px)").matches) $("side-toggle").open = false;
await refresh();
subscribe();
// 执行者的最近动作与「跑了多久」不改账本，隔一会儿重取一次。
setInterval(() => {
  if (!document.hidden && !document.body.classList.contains("expired"))
    refresh();
}, 30000);
