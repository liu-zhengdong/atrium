// Atrium 只读网页。地址：#today、#legion、#oN[/tasks|rules|files]；末段是 tN、cN、sN，或 aN（负责人）、mN（资料，这两种只在部门页）时打开抽屉。
// 数据只从 /ui/api/… 读；/ui/stream 推「changed」时重取当前页与抽屉，数据没变的一处不重画。
"use strict";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = {
  choose: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4" cy="5" r="1.6"/><circle cx="4" cy="11" r="1.6" fill="currentColor"/><path d="M8 5h5.5M8 11h5.5"/></svg>',
  accept: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/></svg>',
  stuck: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 4v5"/><circle cx="8" cy="11.8" r=".6" fill="currentColor"/></svg>',
  reply: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/><path d="M6.6 5.9a1.4 1.4 0 1 1 1.9 1.3c-.4.2-.5.5-.5.9"/><circle cx="8" cy="9.4" r=".5" fill="currentColor" stroke="none"/></svg>',
  escalate: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 13V3.5M4 7.5l4-4 4 4"/></svg>',
  worker: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="3" width="11" height="8" rx="1.5"/><path d="M6 14h4M8 11v3"/></svg>',
  check: '<svg class="check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8.5 6.5 12 13 4.5"/></svg>',
  repeat: '<svg class="rep" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12.5 6.5A4.8 4.8 0 0 0 3.6 5.2M3.5 9.5a4.8 4.8 0 0 0 8.9 1.3"/><path d="M3.3 2.6v2.8h2.8M12.7 13.4v-2.8H9.9"/></svg>',
  once: '<svg class="rep" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2.2 1.4"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
  sort: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 13V3M2.5 5.5 5 3l2.5 2.5M11 3v10M8.5 10.5 11 13l2.5-2.5"/></svg>',
  newline: '<svg class="nl" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12.5 3.5v4a2 2 0 0 1-2 2h-7M6 7 3.5 9.5 6 12"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  file: '<svg class="file" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/></svg>',
  folder: '<svg class="file" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.5 3h4.5l1.5 1.8h7v8.7h-13z"/></svg>',
  wide: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10"/></svg>',
  narrow: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2.5 6H6V2.5M13.5 6H10V2.5M2.5 10H6v3.5M13.5 10H10v3.5"/></svg>',
  out: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 2.5h4.5V7M13.5 2.5l-6 6M11.5 9.5v4h-9v-9h4"/></svg>',
  down: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/></svg>',
  pause: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M5.5 3.5v9M10.5 3.5v9"/></svg>',
};

let nav = { depts: [], names: {}, asks: 0 };
let sortMode = "部门";

// last：每个接口上次取到的数据。切页时先拿它画，新数据到了再换。
const last = new Map();
async function api(path) {
  const body = await (await fetch("/ui/api/" + path)).json();
  if (!body.ok) throw new Error(body.error?.message || "读取失败");
  if (path === "nav") atriumLogo.shipped(body.result.shipped_id);
  last.set(path, body.result);
  return body.result;
}

/* 时间：一小时内「N 分」，一天内「N 时」，更早「MM-DD」 */
const pad = n => String(n).padStart(2, "0");
function ago(ms) {
  const d = Date.now() - ms;
  if (d < 3600e3) return Math.max(1, Math.round(d / 60e3)) + " 分";
  if (d < 86400e3) return Math.round(d / 3600e3) + " 时";
  return date(ms);
}
const date = ms => { const t = new Date(ms); return pad(t.getMonth() + 1) + "-" + pad(t.getDate()); };
// day：今天、明天，更远写 MM-DD
function day(ms) {
  const d = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400e3);
  return d === 0 ? "今天" : d === 1 ? "明天" : date(ms);
}
const clock = ms => { const t = new Date(ms); return pad(t.getHours()) + ":" + pad(t.getMinutes()); };
function size(n) {
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + " MB";
  if (n >= 1 << 10) return Math.round(n / (1 << 10)) + " KB";
  return n + " B";
}
/* 下一轮：一小时内「N 分后」，今天「HH:MM」，明天「明天 HH:MM」，一周内「周X HH:MM」，更远「MM-DD」 */
const WD = "日一二三四五六";
function ahead(ms) {
  const d = ms - Date.now(), t = new Date(ms), day = Math.round((new Date(t).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);
  if (d < 3600e3) return Math.max(1, Math.round(d / 60e3)) + " 分后";
  if (day === 0) return clock(ms);
  if (day === 1) return "明天 " + clock(ms);
  if (day < 7) return "周" + WD[t.getDay()] + " " + clock(ms);
  return date(ms);
}
// objectName：部门与机器沿用名字；身份查服务端共享呈现结果。
const objectName = id => nav.depts.find(d => d.id === id)?.name || identityText(id, nav.names);

/* 地址 */
function parseHash() {
  const segs = location.hash.slice(1).split("/").filter(Boolean);
  if (segs[0] === "legion") return { page: "legion", tab: "", open: segs.length > 1 ? decodeURIComponent(segs.slice(1).join("/")) : null };
  let open = null;
  if (segs.length && /^[tcsam][1-9]\d*$/.test(segs[segs.length - 1])) open = segs.pop();
  return { page: segs[0] || "today", tab: segs[1] || "", open };
}
function hashWith(open) {
  const { page, tab } = parseHash();
  if (page === "legion") return "#legion" + (open ? "/" + encodeURIComponent(open) : "");
  return "#" + [page, tab, open].filter(Boolean).join("/");
}

/* 列表行；depth 是在任务树里的层级（缩进），who 缺省用行自带的；给了 dept 就多一列部门名（今天页） */
function taskRow(r, timeFn = ago, depth = 0, who = r.who, dept) {
  const lead = r.state === "done" ? icon.check : `<span class="dot ${esc(r.state)}"></span>`;
  return `<div class="row ${["done", "draft", "off"].includes(r.state) ? "done" : ""}" data-task="${esc(r.id)}" tabindex="0"${depth ? ` style="--d:${Math.min(depth, 4)}"` : ""}>
    ${lead}<div class="title"><span class="id">${esc(r.id)}</span>${esc(r.title)}</div>
    ${dept === undefined ? "" : `<div class="dept">${esc(dept)}</div>`}<div class="who">${esc(who)}</div>${r.owner ? `<div class="owner">${identityHTML(r.owner, r.owner_label)}</div>` : ""}<div class="time num">${esc(timeFn(r.at))}</div></div>`;
}

/* 定时任务一行：多久一轮（一次性的写「一次 10-08 10:00」，图标换成钟）写在行尾标签，下一轮写在时间列；暂停范围内写「暂停中」。窄屏时间列隐藏，改用下一轮顶替标签（见 app.css）。
   dept：部门页，下面挂上一轮（点开是那件任务）；today：今天页，不挂上一轮，只在出了问题时把问题写在行尾。 */
// 下一轮总写到钟点：窄屏只剩这一列，省了钟点就看不出几点跑。
const schedWhen = s => s.paused ? "暂停中" : ahead(s.next_at);
function schedRow(s, where) {
  const tag = where === "today" ? s.cadence : [s.cadence, s.kind].filter(Boolean).join(" · "); // 今天页那一列只放多久一轮，类型在抽屉里
  const warn = where === "today" && s.trouble;
  const head = `<div class="row sched${warn ? " trouble" : ""}" data-sched="${esc(s.id)}" tabindex="0">${s.once ? icon.once : icon.repeat}
    <div class="title"><span class="id">${esc(s.id)}</span>${esc(s.title)}</div>
    ${where === "today" ? `<div class="dept">${esc(s.dept_name)}</div>` : ""}<div class="who">${warn ? `<span class="warn">上一轮分派任务失败</span>` : esc(tag)}</div><div class="time num">${esc(schedWhen(s))}</div></div>`;
  if (where !== "dept" || !s.last) return head;
  const who = s.trouble ? `<span class="warn">分派任务失败</span>` : esc(s.last.who) + (s.skips ? ` · <span class="warn">跳过 ${s.skips} 轮</span>` : "");
  return head + taskRow({ ...s.last, title: ended(s.last) ? "上一轮" : "这一轮" }, ago, 1).replace(/<div class="who">.*?<\/div>/, `<div class="who">${who}</div>`);
}

/* 任务树：没结束的子任务都摆出来（卡在哪一件一眼可见）；结束的两件以上折成一行，点开再看。展开状态跨刷新保留。 */
const ended = r => r.state === "done" || r.state === "off";
const openKids = new Set();
function kidRows(kids, depth, key, rowFn) {
  const done = kids.filter(ended), rest = kids.filter(k => !ended(k));
  const fold = done.length > 1, open = openKids.has(key);
  return rest.map(k => rowFn(k, depth)).join("") + (fold
    ? `<button class="row kfold" data-kids="${esc(key)}" aria-expanded="${open}" style="--d:${Math.min(depth, 4)}">${icon.chev}<div class="title">已结束 ${done.length} 件</div></button>`
    : "") + (!fold || open ? done.map(k => rowFn(k, depth)).join("") : "");
}
function treeRow(r, depth = 0) {
  return taskRow(r, ago, depth) + (r.kids ? kidRows(r.kids, depth + 1, r.id, treeRow) : "");
}

/* 部门任务分三组：没结束的（不加组名）、草稿、三天内结束的。按根任务分，子任务跟着根走；组名后的数是根的件数 */
function taskGroups(rows) {
  const groups = [
    ["", rows.filter(r => r.state !== "draft" && !ended(r))],
    ["草稿", rows.filter(r => r.state === "draft")],
    ["三天内结束", rows.filter(ended)],
  ].filter(g => g[1].length);
  return groups.map(([name, rs]) =>
    `${name ? `<div class="dept-h group-h"${name === "草稿" ? ' id="drafts"' : ""}>${name}<span class="num">${rs.length}</span></div>` : ""}<div class="rows">${name ? foldRows(rs, "g:" + name, r => treeRow(r)) : rs.map(r => treeRow(r)).join("")}</div>`).join("");
}
/* 长列表先摆前 5 件，其余折成一行「还有 N 件」；more 是接口没列出的件数（只算进件数，展开后末尾写明）。今天完成、部门页的草稿与三天内结束共用 */
const foldAt = 5;
function foldRows(rows, key, rowFn, more = 0) {
  const open = openKids.has(key), rest = rows.length - foldAt;
  return rows.slice(0, rest > 1 && !open ? foldAt : rows.length).map(rowFn).join("")
    + (open && more ? `<div class="more">另有 ${more} 件更早的没列出</div>` : "")
    + (rest > 1 ? `<button class="row kfold" data-kids="${esc(key)}" aria-expanded="${open}">${icon.chev}<div class="title">${open ? "收起" : `还有 ${rest + more} 件`}</div></button>` : "");
}
/* 今天页脉搏行的「草稿 N」：点开到根部门任务页的草稿组 */
function draftsLink(n) {
  const root = nav.depts.find(d => !d.parent);
  if (!n) return "";
  return root ? `<a class="quiet" href="#${esc(root.id)}/tasks" data-drafts>草稿 ${n} 件</a>` : `草稿 ${n} 件`;
}

/* 今天页标题下一行开头的暂停说明；部门写名字，机器写「机器 名字」（机器名单看分不出是机器） */
const pausedName = s => (s[0] === "h" ? "机器 " : "") + objectName(s);
function pausedNote(paused) {
  if (!paused.length) return "";
  const what = paused.includes("all") ? "已全部暂停" : "部分暂停：" + esc(paused.map(pausedName).join("、"));
  return `<span class="paused">${icon.pause}${what}</span>`;
}

/* 今天：三块——等你、在做、「今天完成 | 接下来 7 天」页签；节标题是唯一的一级标签，带件数。列表共用一套列（状态、标题、部门、谁或什么、时间），
   在整页对齐、切页签时不变宽（见 app.css .today）。标题行右侧是三个目标一行；下一行只放没有单独一节的：暂停、排队、草稿，都没有就不出。 */
// 第三块的页签：今天完成（缺省）或接下来 7 天
let soonTab = "done";
let openReceipts = false; // 上报回执折起的展开状态：实时重绘会整段替换页面，重绘后按它还原
/* 三个目标只写近 7 天一行（ledger.Measure 的三个数）；累计在 atrium top 里 */
function goalsLine(g) {
  const w = g.week;
  const bits = [`你纠正 ${w.corrections} 次${w.done ? `（每完成 10 件 ${(w.corrections * 10 / w.done).toFixed(1)} 次）` : ""}`,
    w.offered ? `提给你的方向你选了 ${w.picked}/${w.offered}` : "还没给你提过方向",
    `解决过的同类问题又出现 ${w.recurrences} 次`];
  return `<p class="goals"><span>近 7 天</span>${esc(bits.join(" · "))}</p>`;
}
const count = n => n ? `<span class="n num">${n}</span>` : "";
function todayNote(d) {
  const bits = [pausedNote(d.paused), d.queued ? `${d.queued} 件排队` : "", draftsLink(d.drafts)].filter(Boolean);
  return bits.length ? `<p class="pulse-line">${bits.join(" · ")}</p>` : "";
}
function renderToday(d) {
  // 按部门：一级部门按首次出现的先后排，组内保持原序；按用时：开始早的在前
  const rank = new Map();
  d.running.forEach(r => rank.has(r.group) || rank.set(r.group, rank.size));
  const live = [...d.running].sort(sortMode === "部门" ? (a, b) => rank.get(a.group) - rank.get(b.group) : (a, b) => a.at - b.at);
  // 执行者不可用没有抽屉，点开到执行者页看详情
  const asks = d.asks.length ? `<div class="asks">${d.asks.map(a => `
      <a class="ask ${esc(a.kind)}" href="${a.kind === "worker" ? "#legion" : esc(hashWith(a.id))}">
        <span class="kind">${icon[a.kind]}</span>
        <span class="body"><span class="t">${esc(a.title)}</span><span class="s">${esc(a.sub)}</span></span>
        <span class="meta">${esc(a.dept_name || "")}<br>${esc(ago(a.at))}前</span>
      </a>`).join("")}</div>` : `<div class="empty">没有等你的事</div>`;
  $("#page").innerHTML = `
    <div class="page-head"><h1 class="hello">今天</h1>${goalsLine(d.goals)}</div>
    ${todayNote(d)}
    <div class="today">
    <section class="section"><h2>等你${count(d.asks.length)}</h2>${asks}</section>
    <section class="section"><h2>在做${count(d.running.length)}${d.running.length > 1 ? `<button class="sort" id="sort">按${sortMode}${icon.sort}</button>` : ""}</h2>
      ${live.length ? `<div class="rows">${live.map(r => taskRow(r, ago, 0, r.who, objectName(r.dept))).join("")}</div>` : `<div class="empty">没有在做的</div>`}</section>
    <section class="section"><div class="tabs">
        <button data-soon-tab="done" class="${soonTab === "done" ? "on" : ""}">今天完成${count(d.shipped.length + d.shipped_more)}</button>
        <button data-soon-tab="soon" class="${soonTab === "soon" ? "on" : ""}">接下来 7 天${count(d.soon.rows.length)}</button></div>
      ${soonTab === "soon" ? soonHTML(d.soon) : d.shipped.length ? `<div class="rows">${shippedRows(d.shipped, d.shipped_more)}</div>` : `<div class="empty">今天还没有完成的</div>`}</section>
    ${receiptsHTML(d.receipts, d.receipts_total)}
    </div>`;
}

/* 上报回执：对秘书只知会的上报（cross 收尾确认等），不等待办，折在页面底部按需展开；有任务的点进那件任务。
   total 是总数：超出列出上限时写明还有几条更早的没列出，不静默截断；展开状态跨实时刷新保留。 */
function receiptsHTML(rows, total) {
  if (!rows || !rows.length) return "";
  const more = total > rows.length ? `<div class="more">另有 ${total - rows.length} 条更早的没列出</div>` : "";
  return `<details class="full receipts"${openReceipts ? " open" : ""}><summary>${icon.chev}上报回执<span class="n num">${total}</span></summary>
    <div class="receipts-list">${rows.map(r => `<div class="receipt">
      <div class="t">${esc(r.note)}</div>
      <div class="m">${esc(r.from_name)} · ${esc(r.label || r.kind)}${r.task ? ` · <a href="#today/${esc(r.task)}">${esc(r.task)}</a>` : ""} · ${esc(ago(r.at))}前</div>
    </div>`).join("")}${more}</div></details>`;
}

/* 今天完成（含完成未上线的）：对勾已说明做完，行尾不写状态字；more 是接口列表上限以外的件数 */
function shippedRows(rows, more) {
  return foldRows(rows, "shipped", r => taskRow(r, clock, 0, "", objectName(r.dept)), more);
}

/* 接下来 7 天：按下一轮先后 */
function soonHTML(soon) {
  if (!soon.rows.length) return `<div class="empty">7 天内没有定期的事</div>`;
  return `<div class="rows">${soon.rows.map(s => schedRow(s, "today")).join("")}</div>`
    + (soon.later ? `<div class="more">另有 ${soon.later} 条在 7 天以后</div>` : "");
}

/* 部门；负责人一行只是入口，详情（执行者组合、负责哪些部门、备忘）开在抽屉里，数据就用这一页的 */
// 页头（上级路径与名字）取自侧栏的部门树：这页的数据还没到时也能先摆出来
function deptHead(id) {
  const up = [];
  for (let p = nav.depts.find(d => d.id === id)?.parent; p; p = nav.depts.find(d => d.id === p)?.parent) up.unshift(p);
  return `<div class="crumb">${up.map(p => `<a href="#${esc(p)}">${esc(objectName(p))}</a><span>/</span>`).join("")}</div>
    <h1 class="dept-title">${esc(objectName(id))}</h1>`;
}
function renderDept(d, id, tab) {
  tab = ["tasks", "rules", "files"].includes(tab) ? tab : "tasks";
  const dept = d.dept;
  const subCards = d.subs.map(s => {
    const st = s.stuck ? "bad" : s.running ? "run" : "idle";
    const c = [s.running ? s.running + " 件在做" : "", s.stuck ? s.stuck + " 件卡住" : ""].filter(Boolean).join(" · ") || "没有在做的";
    return `<button class="sub" data-go="${esc(s.id)}"><span class="n"><span class="dot ${st}"></span>${esc(s.name)}</span>
      <span class="w">${esc(s.what)}</span><span class="c">${esc(c)}</span></button>`;
  }).join("");
  const acc = d.accept && { leader: "负责人", user: "你" }[d.accept.who];
  const intro = [["怎么用", dept.uses], ["现状", dept.now], ["下一步", dept.next],
    ["验收", acc && (d.accept.from !== dept.id ? `${acc}（沿用 ${d.accept.from_name}）` : acc)],
    ["仓库", dept.repos.map(r => r.split("/").filter(Boolean).pop()).join("、")]].filter(x => x[1]);
  const sched = d.schedules.length ? `<section class="section"><h2>定时任务<span class="cap">${d.schedules.length}/${d.schedule_max}</span></h2>
    <div class="rows">${d.schedules.map(s => schedRow(s, "dept")).join("")}</div></section>` : "";
  let body = "";
  if (tab === "tasks") body = d.tasks.length ? taskGroups(d.tasks) : `<div class="empty">这个部门现在没有任务</div>`;
  if (tab === "rules") {
    const rule = (r, i) => `<div class="rule ${i === null ? "inh" : ""}"><span class="i">${i === null ? "" : i + 1}</span>
      <span class="t">${esc(r.text)}${r.why ? `<span class="why">${esc(r.why)}</span>` : ""}</span>
      <span class="w">${esc(i === null ? r.dept_name : r.by_label)}</span></div>`;
    body = (d.rules.length ? d.rules.map((r, i) => rule(r, i)).join("") : `<div class="empty">本部门没有自己的规矩</div>`) +
      (d.inherited.length ? `<div class="inh-h">从上级继承</div>${d.inherited.map(r => rule(r, null)).join("")}` : "");
  }
  // 一条资料一行，写说明（matName）；目录资料显示文件数
  if (tab === "files") body = d.materials.length ? `<div class="rows">${d.materials.map(m => `
    <div class="row" data-open="${esc(m.id)}" tabindex="0">${m.files.length > 1 ? icon.folder : icon.file}<div class="title"><span class="id">${esc(m.id)}</span>${esc(matName(m))}</div>
    <div class="who">${m.kind === "overview" ? "总览 · " : ""}v${m.rev} · ${matAmount(m)}</div><div class="time num">${date(m.created_at)}</div></div>`).join("")}</div>`
    : `<div class="empty">还没有资料</div>`;
  const cap = d.rules.length > d.rule_max ? "cap over" : "cap";
  const used = d.materials.reduce((n, m) => n + m.units, 0);
  $("#page").innerHTML = `
    ${deptHead(id)}
    ${dept.what ? `<p class="dept-what">${esc(dept.what)}</p>` : ""}
    ${intro.length ? `<dl class="intro">${intro.map(x => `<dt>${x[0]}</dt><dd>${esc(x[1])}</dd>`).join("")}</dl>` : ""}
    ${d.leader ? `<button class="lead" data-open="${esc(d.leader.id)}"><b>${esc([...d.leader.name][0] || "负")}</b>${esc(identityText(d.leader.id, nav.names))}${d.leader.inherited ? "（上级）" : ""}${icon.chev}</button>` : `<div class="lead"><b>你</b>你直接管<span>秘书帮你盯着</span></div>`}
    ${sched}
    ${d.subs.length ? `<section class="section"><h2>下属部门</h2><div class="subs">${subCards}</div></section>` : ""}
    <section class="section">
      <div class="tabs">
        <button data-tab="tasks" class="${tab === "tasks" ? "on" : ""}">任务</button>
        <button data-tab="rules" class="${tab === "rules" ? "on" : ""}">规矩</button>
        <button data-tab="files" class="${tab === "files" ? "on" : ""}">资料</button>
        ${tab === "rules" ? `<span class="${cap}">${d.rules.length > d.rule_max ? "超限 " : ""}${d.rules.length}/${d.rule_max}</span>` : ""}
        ${tab === "files" ? `<span class="cap${used > d.material_max ? " over" : ""}">${used}/${d.material_max} 字</span>` : ""}
      </div>${body}</section>`;
}

/* 执行者：机器与组合。额度余量不在这里展示，看 OpenQuota 与 magpie */
function renderLegion(d) {
  const hosts = d.hosts.length ? `<div class="hosts">${d.hosts.map(h => `
    <div class="host"><div class="n"><span class="dot ${h.online ? (h.busy ? "run" : "idle") : "off"}"></span><span class="id">${esc(h.id)}</span>${esc(h.name)}</div>
    <div class="s">${h.paused ? `<span class="paused">已暂停</span> · ` : ""}${esc(h.status)} · ${h.busy}/${h.slots} 在用</div>
    <div class="slots">${Array.from({ length: Math.min(h.slots, 32) }, (_, i) => `<i class="${i < h.busy ? "on" : ""}"></i>`).join("")}</div></div>`).join("")}</div>`
    : `<div class="empty">还没有登记机器</div>`;
  const catalog = d.workers.filter(p => !p.problem), extra = d.workers.filter(p => p.problem);
  const combos = comboRows(catalog, d.window) + (extra.length ? `<details class="combo-extra"><summary>${icon.chev}不在目录里 ${extra.length} 个</summary>${comboRows(extra, d.window)}</details>` : "");
  $("#page").innerHTML = `<h1 class="hello">执行者</h1>
  <p class="pulse-line">分派任务只在你配的组合里挑（写过组合档案就封闭，一条都没有才按各工具）；按额度富余自动避让；各套餐余量在 OpenQuota 面板和 magpie 图形界面看。</p>
  <section class="section"><h2>机器</h2>${hosts}</section>
  <section class="section"><h2>组合</h2>${combos}</section>`;
}

const outName = { ok: "交付", bounce: "被交回", quota: "额度", setup: "起不来", fail: "其他失败" };
const trustName = v => ({ high: "高", medium: "中", low: "低", unknown: "未评" }[v] || "未评");
// 交付检查名（gates/judge.go 的 Check*）写成它查什么；web 引用不到 gates，名字以那边为准，没列的原样给
const checkName = { finished: "推送了新提交", pr_exists: "开了 PR", file_growth: "单个文件新增不超上限", claims_verified: "PR 写了端到端验证" };
const markWhen = m => m.until ? (m.open_ended ? `报文没写恢复时刻；${day(m.until)} ${clock(m.until)} 起自动再试` : `${day(m.until)} ${clock(m.until)} 恢复`) : m.kind === "probe" ? "自检跑通后自动解除" : m.kind === "subscription" ? "等订阅恢复" : "等人处理";
const markText = m => `${objectName(m.host)} ${m.reason} · ${markWhen(m)}`;
const workerMarks = marks => (marks || []).map(m => `<div class="mark" title="${esc(m.evidence || "")}">不可用 ${esc(markText(m))}</div>`).join("");
const outcomePips = recent => `<span class="pips runs">${(recent || []).map(o => `<i class="${esc(o)}" title="${esc(outName[o])}"></i>`).join("")}</span>`;
function comboRows(rows, window) {
  return `<div class="combos"><div class="combo-row head"><span></span><span>信任</span><span>近 ${window} 次拉起</span><span class="num">交付</span></div>${rows.map(p => `<a class="combo-row" href="#legion/${encodeURIComponent(p.id)}">
    <span class="combo-name">${esc(p.id)}${workerMarks(p.marks)}</span><span class="trust">${p.trust ? trustName(p.trust) : ""}</span>
    <span title="近 ${window} 次拉起，新的在左">${p.stat.launches ? outcomePips(p.recent) : '<span class="quiet">还没拉起过</span>'}</span><span class="num">${p.stat.launches ? p.stat.ok + "/" + p.stat.launches : ""}</span></a>`).join("")}
    <div class="legend"><i class="ok"></i>交付<i class="bounce"></i>被交回<i class="fail"></i>没拉起来（额度、起不来、其他）</div></div>`;
}
// mdBlock：执行者档案正文是 Markdown，渲染成文档（与资料同一个库，HTML 标签按文字显示）；库按需加载，没到时先摆原文，到了抽屉还是它就重画
function mdBlock(text, redraw, id) {
  if (window.marked) return new marked.Marked({ gfm: true, renderer: { html: t => esc(t.text) } }).parse(text);
  lib("marked").then(() => { if (drawerId === id) redraw(); });
  return `<div class="md-wait">${esc(text)}</div>`;
}
function renderWorker(d) {
  const r = d.resolved, rules = r.rules, st = d.stat;
  drawer(r.id, "组合", `<h3>${esc(r.id)}</h3>${workerMarks(d.marks)}
    <dl class="facts"><dt>信任</dt><dd>${trustName(d.trust)}</dd><dt>接到</dt><dd>${trustName(d.max_risk)}风险</dd>
    <dt>模型</dt><dd>${esc(r.cli_model || "不传，跟随工具自带的缺省")}</dd>
    ${rules.checks ? `<dt>交付检查</dt><dd>${esc(rules.checks.map(c => checkName[c] || c).join("、") || "不加检查")}</dd>` : ""}
    ${rules.endpoint ? `<dt>端点</dt><dd>${esc(rules.endpoint)}（${esc(rules.endpoint_api || "")}）</dd>` : ""}</dl>
    <section class="worker-section"><h4>拉起</h4><p class="quiet">${st.launches ? `近 ${st.launches} 次：交付 ${st.ok} · 被交回 ${st.bounce} · 额度 ${st.quota} · 起不来 ${st.setup} · 其他失败 ${st.fail}` : "还没有拉起记录"}</p>
    <p class="quiet">${esc(d.timing)}</p>
    ${d.quality?.task_consumption ? `<details class="full"><summary>${icon.chev}单次任务消耗</summary><div class="result">${d.quality.task_consumption.text.split(" · ").map(part => `<p>${esc(part)}</p>`).join("")}</div><p class="quiet">近 30 天内创建且已完成；各次拉起累加，类别合并。至少 5 件完整样本才显示中位/P75。P75 为统计分位，不是最坏值。USD 折合不等于套餐积分。</p></details>` : ""}
    ${d.quality?.cost_text ? `<p class="quiet">近 30 天花费：${esc(d.quality.cost_text)}</p>` : ""}
    ${outcomePips((d.attempts || []).map(a => a.outcome))}
    <div class="worker-runs">${(d.attempts || []).map(a => `<div><div class="run-ref"><span class="quiet">${date(a.at)} ${clock(a.at)}</span><a href="#today/${esc(a.task)}">${esc(a.task)}</a> 第 ${a.n} 次 ${esc(a.worker)}（${esc(objectName(a.host))}）${a.model ? `（${esc(a.model)}）` : ""}</div><span class="run-outcome ${a.outcome === "ok" ? "quiet" : "mark"}">${esc(outName[a.outcome])}</span>${a.reason && a.outcome !== "ok" ? `<div class="run-reason mark">${esc(a.reason)}</div>` : ""}</div>`).join("")}</div></section>
    <section class="worker-section"><h4>正文</h4>${r.body ? `<article class="doc worker-body">${mdBlock(r.body, () => renderWorker(d), r.id)}</article>` : `<p class="quiet">没有正文</p>`}</section>
    <section class="worker-section"><h4>各层原文</h4>${d.layers.map(p => `<details class="layer"><summary>${icon.chev}${esc(p.name)}<span class="quiet">${date(p.updated_at)}</span></summary><pre>${esc(p.source)}</pre><code>atrium workers edit ${esc(p.name)} --file &lt;档案&gt;</code></details>`).join("") || '<p class="quiet">没有档案</p>'}</section>`);
}

/* 经过：按执行者说的话分段；命令显示原文，点开看完整命令与输出最后 30 行。展开状态跨刷新保留。 */
const unfolded = new Set();
const md = s => esc(s).replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  .replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
const firstPara = s => s.trim().split(/\n\s*\n/)[0];
// 多行命令压成一行（已转义的 HTML），换行处画换行图标；max 按字符截断。
const oneLine = (s, max) => esc(s.trim().replace(/\s*\n\s*/g, "\n").slice(0, max)).replaceAll("\n", icon.newline);
const cmdNote = { run: "在跑", err: "出错", none: "没搜到", ok: "" };
const cmdsOf = segs => segs.flatMap(s => s.cmds || []);
const maxPips = 20; // 每段最多画这么多点，多的写「+N」
const pips = cmds => `<span class="pips">${cmds.slice(0, maxPips).map(c => `<i class="${c.state}"></i>`).join("")}${cmds.length > maxPips ? `<b>+${cmds.length - maxPips}</b>` : ""}</span>`;
// 折叠行只写数：几段、几条命令、几条出错（没有不写）。
function tally(segs) {
  const cmds = cmdsOf(segs), errs = cmds.filter(c => c.state === "err").length;
  return `${segs.length} 段 · ${cmds.length} 条命令${errs ? ` · <span class="errn">${errs} 条出错</span>` : ""}`;
}
function since(ms) {
  const m = Math.max(1, Math.round((Date.now() - ms) / 60e3));
  return m < 60 ? m + " 分钟" : Math.floor(m / 60) + " 小时 " + (m % 60) + " 分钟";
}
function segHTML(tid, s, i, running) {
  const cmds = s.cmds || [], key = tid + ":" + i;
  const exp = unfolded.has(key) || (running && !unfolded.has(key + ":closed"));
  const last = cmds[cmds.length - 1];
  const list = exp ? `<div class="cmds">${cmds.map((c, j) => {
    const k = key + ":" + j, o = unfolded.has(k);
    return `<div class="cmd ${c.state}"><button data-c="${k}" aria-expanded="${o}"><span class="lbl">${oneLine(c.cmd)}</span><span class="st">${cmdNote[c.state]}</span></button>
      ${o ? `<div class="detail"><div class="c">$ ${esc(c.cmd)}</div>${c.state === "run" ? "" : `<div class="o">${esc(c.out) || "（没有输出）"}</div>`}</div>` : ""}</div>`;
  }).join("")}</div>` : "";
  return `<div class="phase ${running ? "run" : ""}"><span class="pd"></span><div>
    ${s.say ? `<div class="say">${md(s.say)}</div>` : `<div class="say quiet">先看代码</div>`}
    ${cmds.length ? `<button class="grp" data-g="${key}" aria-expanded="${exp}">${icon.chev}${cmds.length} 条命令${pips(cmds)}</button>` : ""}
    ${running && !exp && last?.state === "run" ? `<div class="nowrun">正在跑：<code>${oneLine(last.cmd, 60)}</code></div>` : ""}${list}</div></div>`;
}
function traceHTML(d) {
  const tr = d.trace;
  if (!tr) return "";
  const tid = d.task.id, segs = tr.segments, n = cmdsOf(segs).length;
  const usage = d.usage_text ? `<div class="jh"><b>拉起用量</b></div><p>${esc(d.usage_text)}</p>` : "";
  const lines = (tr.unknown ? `<div class="jh"><b>没认出</b><span>${tr.unknown} 行事件，工具的日志格式可能变了</span></div>` : "")
    + (tr.lines?.length ? `<div class="log">${esc(tr.lines.join("\n"))}</div>` : "");
  const fold = (key, label, open) => `<button class="grp fold" data-g="${tid}:${key}" aria-expanded="${open}">${icon.chev}<span>${label}</span></button>`;
  if (!segs.length && !tr.ended) return usage + (lines ? `<div class="jh"><b>日志</b></div>${lines}` : "");
  if (d.live) { // 进行中：只留最近两段，当前段展开，更早的折起
    const older = segs.slice(0, Math.max(0, segs.length - 2)), showOld = unfolded.has(tid + ":old");
    return `<div class="jh"><b>经过</b><span>${n} 条命令</span></div>`
      + (older.length ? fold("old", `前面还有 ${tally(older)}`, showOld) : "")
      + (showOld ? older.map((s, i) => segHTML(tid, s, i, false)).join("") : "")
      + segs.slice(older.length).map((s, k) => segHTML(tid, s, older.length + k, older.length + k === segs.length - 1)).join("") + lines;
  }
  let out = usage;
  if (tr.ended && tr.result) { // 已完成：先给结果第一段，其余折进「全文」；经过整体折起
    const full = unfolded.has(tid + ":full"), more = firstPara(tr.result) !== tr.result.trim();
    out += `<div class="jh"><b>结果</b>${tr.ms ? `<span>用时 ${Math.max(1, Math.round(tr.ms / 60e3))} 分钟</span>` : ""}</div>
      <div class="result">${md(full ? tr.result.trim() : firstPara(tr.result))}</div>${more ? fold("full", full ? "收起" : "全文", full).replace(" fold", "") : ""}`;
  }
  if (segs.length) {
    const showAll = unfolded.has(tid + ":all");
    out += `<div class="jh"><b>经过</b></div>` + fold("all", tally(segs), showAll)
      + (showAll ? segs.map((s, i) => segHTML(tid, s, i, false)).join("") : "");
  }
  return out + lines;
}

/* 抽屉里的上下级与依赖：一节一组行，点一行换成那件任务；和这件不在一个部门的，行尾加部门名 */
function relHTML(d) {
  const org = d.task.org;
  const rel = r => taskRow(r, ago, 0, r.dept && r.dept !== org ? `${r.who ? r.who + " · " : ""}${objectName(r.dept)}` : r.who);
  const part = (name, rows, note = "") => rows.length ? `<div class="jh"><b>${name}</b>${note ? `<span>${note}</span>` : ""}</div><div class="rows">${rows}</div>` : "";
  const done = d.kids.filter(r => r.state === "done").length;
  return part("子任务", kidRows(d.kids, 0, "d:" + d.task.id, r => rel(r)), d.kids.length ? `${done}/${d.kids.length} 完成` : "")
    + part("要等", d.waits.map(rel).join(""))
    + part("在等它", d.waiters.map(rel).join(""));
}

/* 抽屉：头部写短号与所属（部门名、「负责人」），同一件东西重画时保留滚动位置（推送一来就重画，读长文不能跳回顶）。
   tools 是关闭钮前的按钮，只有资料抽屉给：它更宽，还能放宽 */
let drawerId = "";
function drawer(id, of, body, tools = "") {
  const keep = drawerId === id ? $("#drawer .dbody")?.scrollTop || 0 : 0;
  drawerId = id;
  $("#drawer").classList.toggle("mat", !!tools);
  $("#drawer").classList.toggle("wide", !!tools && wide);
  $("#drawer").innerHTML = `<div class="dhead"><span class="id">${esc(id)}${of ? ` <b>· ${esc(of)}</b>` : ""}</span>${tools}<button class="x" data-close aria-label="关闭">${icon.x}</button></div>
    <div class="dbody">${body}</div>`;
  $("#drawer .dbody").scrollTop = keep;
}
const sourceLabel = { user: "用户纠正", org: "组织发现" };
/* 来源后的记录人：负责人的名字链到他的负责人抽屉 */
const byHTML = d => !d.by_name ? "" : " · " + (d.by_lead
  ? `<a href="#${esc(d.by_lead)}">${esc(d.by_name)}</a>` : esc(d.by_name));
let drawerTask = null;
function renderTask(d) {
  drawerTask = d;
  const t = d.task;
  const stuck = d.state === "bad";
  const pr = !t.pr ? "" : /^https?:\/\//.test(t.pr) ? `<a href="${esc(t.pr)}" target="_blank" rel="noreferrer">${esc(t.pr.replace(/^.*\/pull\//, "#"))}</a>` : esc(t.pr);
  const draft = d.state === "draft";
  // 结束了的：状态一行已说清，不画步骤条，结果写在标题下一行；没结束的留灰底状态块，在跑的写已跑多久
  const over = d.state === "done" || d.state === "off";
  const label = stuck ? "卡住" : draft ? "草稿" : "现在";
  const holder = draft ? "还没想清楚，不分派任务、不计时" : d.holder;
  const when = d.live ? "已跑 " + since(d.run_at) : ago(t.updated_at);
  // 下面的事实有值才出现；执行者和机器一行
  const host = t.host && [t.host, objectName(t.host)].filter((x, i, a) => a.indexOf(x) === i).join(" ");
  const facts = [["执行者", t.worker && esc([t.worker, host].filter(Boolean).join(" · "))], ["PR", pr],
    ["技能", t.skill && esc(t.skill)], ["来自", d.schedule && `<a href="${esc(hashWith(d.schedule))}">定时任务 ${esc(d.schedule)}</a>`],
    ["选项单", d.choice && `<a href="${esc(hashWith(d.choice))}">${esc(d.choice)}</a>`]].filter(f => f[1]);
  drawer(t.id, d.dept_name, `
      ${d.parent ? `<div class="crumb up"><a href="${esc(hashWith(d.parent.id))}"><span class="id">${esc(d.parent.id)}</span>${esc(d.parent.title)}</a><span>/</span></div>` : ""}
      <h3>${esc(t.title)}</h3>
      ${draft || over ? "" : `<div class="steps">${d.steps.map((s, i) => `<div class="step ${i < d.step ? "past" : i === d.step ? "now" + (stuck ? " stuck" : "") : ""}"><i></i>${s}</div>`).join("")}</div>`}
      ${over ? `<p class="sub-t done-line">${esc(d.holder)} · ${esc(ago(t.updated_at))}前</p>` : `<div class="holder"><b>${label}</b>　${esc(holder)} · ${esc(draft ? ago(t.updated_at) : when)}</div>`}
      ${draft ? `<p class="draft-detail">${t.detail ? esc(t.detail) : "没有详述"}</p>` : facts.length ? `<dl class="facts">${facts.map(f => `<dt>${f[0]}</dt><dd>${f[1]}</dd>`).join("")}</dl>` : ""}
      ${t.source || t.class ? `<dl class="facts"><dt>来源</dt><dd>${esc(sourceLabel[t.source] || "没写")}${byHTML(d)}</dd><dt>类</dt><dd>${esc(t.class || "没归类")}</dd></dl>` : ""}
      ${partiesHTML(d)}${historyHTML(d)}${relHTML(d)}
      ${traceHTML(d)}`);
}
const openOpts = new Set();
let drawerChoice = null;
function renderChoice(c) {
  drawerChoice = c;
  const status = c.status === "open" ? "" : c.status === "picked" ? "已拍板" : c.status === "void" ? "已作废" : "这轮都不做";
  const rec = new Set(c.recommend || []);
  drawer(c.id, c.dept_name, `<h3>${esc(c.title)}</h3><p class="sub-t">${c.task ? "出自 " + esc(c.task) + " · " : ""}${esc(c.created_by_label)} · ${esc(ago(c.created_at))}前${status ? " · " + status : ""}</p>
      ${c.reason ? `<p class="status-line">${esc(c.reason)}</p>` : ""}
      <div class="opts">${c.options.map(o => {
        const open = openOpts.has(c.id + ":" + o.pos);
        return `<button class="opt ${o.task ? "on" : ""}${open ? " open" : ""}" data-opt="${esc(c.id + ":" + o.pos)}" aria-expanded="${open}">
          <span class="pos num">${o.pos}</span>
          <div><div class="t">${esc(o.title)}${rec.has(o.pos) ? '<span class="rec">推荐</span>' : ""}${o.task ? `<span class="pick">已选 · ${esc(o.task)}</span>` : ""}</div>
          <div class="g">${esc(o.gain)}</div>
          <div class="cost"><b>代价</b>${esc(o.cost)}</div>
          ${open ? `<dl class="why"><dt>为什么现在</dt><dd>${esc(o.why_now)}</dd>${o.if_not ? `<dt>不做</dt><dd>${esc(o.if_not)}</dd>` : ""}</dl>` : ""}</div>
          <span class="opt-more">${icon.chev}</span></button>`;
      }).join("")}</div>
      ${c.note ? `<p class="status-line">${c.status === "void" ? "已作废：" : ""}${esc(c.note)}</p>` : ""}
      ${c.status === "open" ? `<p class="status-line">选哪几个，在终端里告诉秘书。</p>` : ""}`);
}
/* 定时任务抽屉：下一轮的完整时刻、每轮做什么、最近几轮（点开是那件任务）、最近一笔记录，详述折起；一次性的没有「最近几轮」（生成后这条就删了） */
const kindDoes = { "调研": "写一张选项单给你挑", "体验巡检": "把主路径走一遍，能修的开 PR" };
function renderSchedule(s) {
  const w = ahead(s.next_at), next = new Date(s.next_at), wake = s.kind === "自唤醒";
  const when = s.paused ? `暂停中：到点不生成，恢复后${s.once ? "补这一次" : "只补一轮"}`
    : /^\d\d-/.test(w) ? `${w} ${clock(s.next_at)}` : `${/^\d\d:/.test(w) ? "今天 " : ""}${w}（${pad(next.getMonth() + 1)}-${pad(next.getDate())}）`;
  const facts = [[s.once ? "做什么" : "每轮", kindDoes[s.kind] || firstPara(s.detail)], ["技能", s.skill]].filter(x => x[1]);
  const day = r => (r.title.match(/（(\d\d-\d\d)）$/) || [])[1];
  drawer(s.id, s.dept_name, `<h3>${esc(s.title)}</h3>
      <p class="sub-t">${esc([s.cadence, s.kind].filter(Boolean).join(" · "))} · ${esc(s.by_label)} ${esc(date(s.created_at))} 建</p>
      <div class="holder"><b>${s.once ? "到点" : "下一轮"}</b>　${esc(when)}</div>
      ${facts.length ? `<dl class="facts">${facts.map(f => `<dt>${f[0]}</dt><dd>${esc(f[1])}</dd>`).join("")}</dl>` : ""}
      ${s.once ? `<div class="quiet-line">到点${wake ? "提醒负责人" : "生成一件任务并派发"}，之后这条自动删除</div>` : wake ? "" : `<div class="jh"><b>最近几轮</b>${s.skips ? `<span>跳过过 ${s.skips} 轮</span>` : ""}</div>
      ${s.rounds.length ? `<div class="rows">${s.rounds.map(r => taskRow({ ...r, title: day(r) ? day(r) + " 这一轮" : r.title })).join("")}</div>` : `<div class="quiet-line">还没跑过</div>`}`}
      ${s.note ? `<p class="status-line${s.trouble ? " warn" : ""}">${esc(s.note)}</p>` : ""}
      ${s.detail ? `<details class="full"><summary>${icon.chev}详述</summary><div class="result">${md(s.detail.trim())}</div></details>` : ""}`);
}
/* 负责人抽屉：执行者组合、负责哪些部门，备忘一行一段，行首「话题：」加重，两千字也能扫着找 */
const memoHTML = s => s.trim().split(/\n\s*/).map(p => {
  const m = p.match(/^([^：，。；]{1,24})：(.+)$/s);
  return `<p>${m ? `<b>${esc(m[1])}</b>：${md(m[2])}` : md(p)}</p>`;
}).join("");
function renderLeader(deptPage, id) {
  const l = deptPage.leader;
  if (l?.id !== id) throw new Error(id + " 不是这个部门的负责人");
  const n = [...l.memo].length;
  drawer(l.id, "负责人", `<h3>${esc(identityText(l.id, nav.names))}</h3>
    ${l.inherited ? `<p class="sub-t">${esc(deptPage.dept.name)}没有自己的负责人，由上级的这一位管</p>` : ""}
    <dl class="facts"><dt>执行者</dt><dd>${esc(l.workers)}</dd>
      <dt>负责</dt><dd>${l.depts.map(p => `<a href="#${esc(p.id)}">${esc(p.name)}</a>`).join("、")}</dd></dl>
    <div class="jh"><b>备忘</b><span class="num">${n}/${deptPage.memo_max} 字</span></div>
    ${n ? `<div class="memo">${memoHTML(l.memo)}</div>` : `<div class="quiet-line">还没写备忘</div>`}`);
}
/* 资料抽屉：一条资料是一个文件或一个目录。打开渲染正文（entry），按扩展名一处分派（viewers）；原文取自 /ui/material/mN/<相对路径>。
   md 里的相对图片、链接在这条资料的文件里找；没有正文的（图片集）列出全部文件。
   html 只在沙箱 iframe 里（不放行同源，脚本碰不到网页）；md、docx、xlsx 用的库 embed 在二进制里（static/lib），打开这类文件时才加载。 */
const kinds = { md: "md", markdown: "md", html: "html", htm: "html", pdf: "pdf", docx: "docx", xlsx: "xlsx",
  png: "img", jpg: "img", jpeg: "img", gif: "img", webp: "img", avif: "img", bmp: "img", svg: "img" };
const extKind = p => kinds[(p.match(/\.([^./]+)$/)?.[1] || "").toLowerCase()];
const kindOf = m => !m.entry ? "set" : extKind(m.entry) || (m.files.find(f => f.path === m.entry)?.binary ? "file" : "text");
const baseName = p => p.split("/").pop();
// matName：资料在网页上叫它的说明（交资料时必填、写给人看的「里面有什么」）；标题是交资料时的文件名或目录名（delivery、shots 这类），看不出是什么
const matName = m => m.note || m.title;
const matAmount = m => [m.files.length > 1 ? m.files.length + " 个文件" : "", size(m.size)].filter(Boolean).join(" · ");
// 以文件路径结尾的地址：html 里的相对路径由浏览器落到同一条资料里；新窗口打开、另存也带着文件名
const pathURL = p => p.split("/").map(encodeURIComponent).join("/");
const namedURL = (m, p = m.entry) => `/ui/material/${m.id}/${pathURL(p)}`;
// html 正文另走带键的沙箱地址（m.frame）：页面里的模块脚本、fetch 要跨域放行才读得到同一条资料里的文件
const frameURL = m => m.frame + pathURL(m.entry);
const matURL = (m, p = m.entry) => namedURL(m, p) + `?rev=${m.rev}`;
async function fetchMat(m, as) {
  const r = await fetch(matURL(m));
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.message || "读取失败 " + r.status);
  return r[as]();
}
const loaded = {};
const lib = (...names) => names.reduce((p, n) => p.then(() => loaded[n] ??= new Promise((ok, bad) => {
  const s = document.createElement("script");
  s.src = "/ui/assets/lib/" + n + ".js";
  s.onload = ok;
  s.onerror = () => { delete loaded[n]; bad(new Error("加载 " + n + " 失败")); };
  document.head.append(s);
})), Promise.resolve());
// inside：正文 entry 里的相对路径 href 指向这条资料里的哪个路径（越出资料返回空）
function inside(entry, href) {
  const out = entry.split("/").slice(0, -1);
  let p = href.split(/[?#]/)[0];
  try { p = decodeURIComponent(p); } catch (_) { /* 不是合法转义就按原样 */ }
  for (const s of p.split("/")) {
    if (s === "..") { if (!out.length) return ""; out.pop(); } else if (s && s !== ".") out.push(s);
  }
  return out.join("/");
}
function mdDoc(text, m) {
  const find = href => {
    if (/^([a-z][\w+.-]*:|[/#])/i.test(href)) return "";
    const p = inside(m.entry, href);
    return m.files.some(f => f.path === p) ? p : "";
  };
  const gone = (href, body) => `<span class="gone" title="这条资料里没有 ${esc(href)}">${body}</span>`;
  const renderer = {
    html: t => esc(t.text), // 资料里的 HTML 标签按文字显示，不进网页
    image({ href, text }) {
      const p = find(href), alt = esc(text || href);
      if (p) return `<img src="${esc(matURL(m, p))}" alt="${esc(text)}" loading="lazy">`;
      return /^https?:/i.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noreferrer">图：${alt}</a>` : gone(href, "图：" + alt);
    },
    link({ href, tokens }) {
      const body = this.parser.parseInline(tokens), p = find(href);
      if (/^(https?|mailto):/i.test(href)) return `<a href="${esc(href)}" target="_blank" rel="noreferrer">${body}</a>`;
      if (p) return `<a href="${esc(matURL(m, p))}" target="_blank" rel="noopener">${body}</a>`;
      return href.startsWith("#") ? body : gone(href, body); // 文内锚点会和网页地址冲突，只留文字
    },
  };
  return new marked.Marked({ gfm: true, renderer }).parse(text);
}
// fileList：资料里的全部文件，图片出缩略图，点开是原文件
const fileList = m => `<div class="mfiles">${m.files.map(f => `<a href="${esc(matURL(m, f.path))}" target="_blank" rel="noopener">
  ${extKind(f.path) === "img" ? `<img src="${esc(matURL(m, f.path))}" alt="" loading="lazy">` : `<span class="ph">${icon.file}</span>`}
  <span class="n">${esc(f.path)}</span><span class="s">${size(f.size)}</span></a>`).join("")}</div>`;
const sheetRows = 1000; // 表格只读前这么多行：网页里看不过来，完整的下载看
const viewers = {
  async md(el, m) {
    const [text] = await Promise.all([fetchMat(m, "text"), lib("marked")]);
    return `<article class="doc">${mdDoc(text, m)}</article>`;
  },
  html: (el, m) => `<iframe class="frame" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" src="${esc(frameURL(m))}" title="${esc(matName(m))}"></iframe>`,
  pdf: (el, m) => `<iframe class="frame" src="${esc(matURL(m))}" title="${esc(matName(m))}"></iframe>`,
  img: (el, m) => `<img class="pic" src="${esc(matURL(m))}" alt="${esc(matName(m))}">`,
  text: async (el, m) => `<pre class="plain">${esc(await fetchMat(m, "text"))}</pre>`,
  async docx(el, m) {
    const [buf] = await Promise.all([fetchMat(m, "arrayBuffer"), lib("jszip", "docx-preview")]);
    el.innerHTML = "";
    await docx.renderAsync(buf, el, null, { inWrapper: false, ignoreWidth: true, ignoreHeight: true, breakPages: false, useBase64URL: true, ignoreFonts: true });
  },
  async xlsx(el, m) {
    const [buf] = await Promise.all([fetchMat(m, "arrayBuffer"), lib("xlsx")]);
    const wb = XLSX.read(buf, { sheetRows: sheetRows + 1 });
    const show = name => {
      const ws = wb.Sheets[name], rows = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]).e.r + 1 : 0;
      el.innerHTML = (wb.SheetNames.length > 1 ? `<div class="tabs">${wb.SheetNames.map(n => `<button data-sheet="${esc(n)}" class="${n === name ? "on" : ""}">${esc(n)}</button>`).join("")}</div>` : "")
        + (rows ? `<div class="sheet">${XLSX.utils.sheet_to_html(ws, { header: "", footer: "" })}</div>` : `<div class="empty">这张表是空的</div>`)
        + (rows > sheetRows ? `<div class="more">只显示前 ${sheetRows} 行，完整的下载看</div>` : "");
    };
    el.onclick = e => { const b = e.target.closest("[data-sheet]"); if (b) show(b.dataset.sheet); };
    show(wb.SheetNames[0]);
  },
  file: (el, m) => `<div class="empty">这种格式网页里看不了，下载后用本机的应用打开</div>
    <a class="dl" href="${esc(matURL(m))}" download="${esc(baseName(m.entry))}">${icon.down}下载 ${esc(baseName(m.entry))}</a>`,
  set: (el, m) => fileList(m),
};
let shownMat = "", wide = false;
function renderMaterial(deptPage, id) {
  const m = deptPage.materials.find(o => o.id === id);
  if (!m) throw new Error(id + " 不在这个部门没归档的资料里");
  const key = m.id + "/" + m.rev, kind = kindOf(m);
  if (drawerId === id && shownMat === key) return; // 推送重取整页时资料没换版就不重画：iframe 不重载，表格停在原来那张
  shownMat = key;
  const tip = label => `aria-label="${label}" title="${label}"`;
  const tools = `<button class="tool" data-wide ${tip(wide ? "收窄" : "放宽")}>${wide ? icon.narrow : icon.wide}</button>`
    + (["file", "docx", "xlsx", "set"].includes(kind) ? "" // 浏览器自己打不开的，新窗口只会变成下载
      : `<a class="tool" href="${esc(kind === "html" ? frameURL(m) : namedURL(m))}" target="_blank" rel="noopener" ${tip("新窗口打开")}>${icon.out}</a>`)
    + (kind === "set" ? "" : `<a class="tool" href="${esc(matURL(m))}" download="${esc(baseName(m.entry))}" ${tip("下载正文")}>${icon.down}</a>`);
  const meta = [m.kind === "overview" ? "总览" : "", "v" + m.rev, matAmount(m), m.created_by_label, date(m.created_at)].filter(Boolean);
  // 有正文的目录资料：正文下面折起全部文件（图源、没被正文引用的图也找得到）
  const all = kind !== "set" && m.files.length > 1
    ? `<details class="full"><summary>${icon.chev}这条资料里的 ${m.files.length} 个文件</summary>${fileList(m)}</details>` : "";
  drawer(id, deptPage.dept.name, `<h3>${esc(matName(m))}</h3><p class="sub-t">${esc(meta.join(" · "))}</p>
    <div class="viewer ${kind}" id="viewer"><div class="quiet-line">正在打开…</div></div>${all}`, tools);
  const el = $("#viewer"), still = () => drawerId === id && shownMat === key;
  Promise.resolve().then(() => viewers[kind](el, m))
    .then(html => { if (still() && html !== undefined) el.innerHTML = html; })
    .catch(err => { if (still()) el.innerHTML = `<div class="empty">打不开：${esc(err.message)}</div>`; });
}
function openDrawer() {
  if ($("#island").classList.contains("open")) return;
  $("#island").classList.add("open");
  setTimeout(() => $("#drawer").focus(), 50);
}
function closeDrawer() { $("#island").classList.remove("open"); drawerId = shownDrawer = shownMat = ""; }

/* 侧栏 */
function renderTree(cur) {
  const kids = id => nav.depts.filter(d => (d.parent || "") === id);
  const onPath = new Set();
  for (let id = cur; id; id = nav.depts.find(d => d.id === id)?.parent) onPath.add(id);
  const item = (d, l) => `<a href="#${esc(d.id)}" class="${cur === d.id ? "on" : ""}" style="padding-left:${8 + 16 * l}px">${esc(d.name)}${d.stuck ? '<span class="dot bad" title="有卡住的任务"></span>' : ""}</a>`;
  const walk = (parent, l) => kids(parent).map(d =>
    item(d, l) + (l === 0 || onPath.has(d.id) ? walk(d.id, l + 1) : "")).join("");
  $("#tree").innerHTML = walk("", 0) || (last.has("nav") ? `<div class="group">还没有部门</div>` : "");
  document.querySelectorAll("[data-nav]").forEach(a => a.classList.toggle("on", a.dataset.nav === cur));
  const count = $("#askCount");
  count.textContent = nav.asks;
  count.hidden = !nav.asks;
  $("#mnav").innerHTML = [["today", "今天"], ["legion", "执行者"], ...nav.depts.map(d => [d.id, "部门 · " + d.name])]
    .map(o => `<option value="${esc(o[0])}" ${o[0] === cur ? "selected" : ""}>${esc(o[1])}</option>`).join("");
}

/* 路由：点了立刻切——导航、页头马上换，有上次的数据先画上次的（没有画骨架）；nav 与页面、抽屉的数据并行取，到了再换。
   推送来的 changed 也走这里：数据没变的一处不重画，变了的重画时保留滚动和打开的抽屉。 */
function pageOf(page, tab) {
  if (page === "legion") return { path: "legion", head: `<h1 class="hello">执行者</h1>`, draw: renderLegion };
  if (/^o[1-9]\d*$/.test(page)) return { path: "dept/" + page, head: deptHead(page), draw: d => renderDept(d, page, tab) };
  return { path: "today", head: `<h1 class="hello">今天</h1>`, draw: renderToday };
}
function drawerOf(open, page) {
  if (page === "legion") return { path: "worker?name=" + encodeURIComponent(open), draw: renderWorker };
  if (open[0] === "a") return { path: "dept/" + page, draw: d => renderLeader(d, open) }; // 负责人、资料抽屉用部门页的数据
  if (open[0] === "m") return { path: "dept/" + page, draw: d => renderMaterial(d, open) };
  const [path, draw] = { c: ["choice/", renderChoice], s: ["schedule/", renderSchedule] }[open[0]] || ["task/", renderTask];
  return { path: path + open, draw };
}
// 骨架：这一页还没取到过数据时先占住版面（慢于 0.15 秒才淡入，数据很快到时不闪）
const skeleton = `<div class="skel">${`<section class="section"><i class="h"></i>${"<i></i>".repeat(4)}</section>`.repeat(2)}</div>`;
let shownPage = "", shownKey = "", shownDrawer = "";
function showPage(force) {
  const { page, tab } = parseHash(), p = pageOf(page, tab), d = last.get(p.path);
  const key = page + "/" + tab + JSON.stringify([d ?? null, nav.names]);
  if (key === shownKey && !force) return;
  const top = page === shownPage ? $("#scroll").scrollTop : 0; // 换了页回到顶，同一页（含换页签）保留滚动
  shownPage = page; shownKey = key;
  if (d) p.draw(d); else $("#page").innerHTML = p.head + skeleton;
  $("#scroll").scrollTop = top;
}
function showDrawer(open, page) {
  const dr = drawerOf(open, page), d = last.get(dr.path), key = open + JSON.stringify([d ?? null, nav.names]);
  if (key === shownDrawer) return;
  shownDrawer = key;
  if (d) dr.draw(d); else drawer(open, "", skeleton);
}
function fail(err) {
  shownKey = "";
  $("#page").innerHTML = `<div class="empty">读取失败：${esc(err.message)}</div>`;
}
let seq = 0, rendering = null, liveTimer = null;
let toDrafts = false; // 从今天页的「草稿 N 件」进来：画好后滚到草稿组
async function route() {
  const n = ++seq, { page, tab, open } = parseHash();
  clearTimeout(liveTimer);
  try {
    renderTree(page);
    showPage();
    if (open) { showDrawer(open, page); openDrawer(); } else closeDrawer();
    await Promise.all([...new Set(["nav", pageOf(page, tab).path, open && drawerOf(open, page).path])].filter(Boolean).map(api));
    if (n !== seq) return; // 等的时候又点了别处：由新的那次来画
    nav = last.get("nav");
    renderTree(page);
    showPage();
    if (open) showDrawer(open, page);
    if (toDrafts) { toDrafts = false; $("#drafts")?.scrollIntoView({ block: "start" }); }
    if (page !== "legion" && open?.[0] === "t" && last.get("task/" + open).live) liveTimer = setTimeout(refresh, 5000); // 执行者在干时日志一直在长，抽屉每 5 秒重取
  } catch (err) { if (n === seq && !atriumLogo.reconnecting) fail(err); }
}
function refresh() {
  clearTimeout(rendering);
  rendering = setTimeout(route, 250);
}

addEventListener("hashchange", route);
$("#mnav").onchange = e => { location.hash = e.target.value; };
document.addEventListener("click", e => {
  if (e.target.closest("[data-drafts]")) { toDrafts = true; openKids.add("g:草稿"); }
  const w = e.target.closest("[data-wide]");
  if (w) {
    wide = !wide;
    $("#drawer").classList.toggle("wide", wide);
    w.innerHTML = wide ? icon.narrow : icon.wide;
    w.title = w.ariaLabel = wide ? "收窄" : "放宽";
    return;
  }
  const st = e.target.closest("[data-soon-tab]"); if (st) { soonTab = st.dataset.soonTab; return showPage(true); }
  if (e.target.closest("#sort")) { sortMode = sortMode === "部门" ? "用时" : "部门"; return showPage(true); }
  const tb = e.target.closest("[data-tab]"); if (tb) { location.hash = parseHash().page + "/" + tb.dataset.tab; return; }
  const fold = e.target.closest("#drawer [data-g]");
  if (fold) {
    const k = fold.dataset.g;
    if (fold.getAttribute("aria-expanded") === "true") { unfolded.delete(k); unfolded.add(k + ":closed"); }
    else { unfolded.add(k); unfolded.delete(k + ":closed"); }
    return renderTask(drawerTask);
  }
  const op = e.target.closest("[data-opt]");
  if (op) { const k = op.dataset.opt; openOpts.has(k) ? openOpts.delete(k) : openOpts.add(k); return renderChoice(drawerChoice); }
  const kf = e.target.closest("[data-kids]");
  if (kf) {
    const k = kf.dataset.kids;
    openKids.has(k) ? openKids.delete(k) : openKids.add(k);
    return kf.closest("#drawer") ? renderTask(drawerTask) : showPage(true);
  }
  const cmd = e.target.closest("#drawer [data-c]");
  if (cmd) { const k = cmd.dataset.c; unfolded.has(k) ? unfolded.delete(k) : unfolded.add(k); return renderTask(drawerTask); }
  if (e.target.closest(".owner a")) return;
  const t = e.target.closest("[data-task]"); if (t) { location.hash = hashWith(t.dataset.task); return; }
  const sc = e.target.closest("[data-sched]"); if (sc) { location.hash = hashWith(sc.dataset.sched); return; }
  const a = e.target.closest("[data-open]"); if (a) { location.hash = hashWith(a.dataset.open); return; }
  const g = e.target.closest("[data-go]"); if (g) { location.hash = g.dataset.go; return; }
  if (e.target.closest("[data-close]") || e.target.id === "scrim") location.hash = hashWith(null);
});
/* 折起的展开状态：实时刷新（SSE 推 changed）会整段重画页面，记住 #page 里上报回执的展开，重画后按它还原 */
document.addEventListener("toggle", e => {
  if (e.target?.classList?.contains("receipts")) openReceipts = e.target.open;
}, true);
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && parseHash().open) location.hash = hashWith(null);
  const sc = e.target.closest?.("[data-sched]");
  if (sc && e.key === "Enter") location.hash = hashWith(sc.dataset.sched);
  const op = e.target.closest?.("div[data-open]"); // 资料行；按钮自己会响应回车
  if (op && e.key === "Enter") location.hash = hashWith(op.dataset.open);
  if (e.target.closest?.(".owner a")) return;
  const t = e.target.closest?.("[data-task]");
  if (t && e.key === "Enter") location.hash = hashWith(t.dataset.task);
  if (t && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    const all = [...document.querySelectorAll("#page [data-task]")];
    const i = all.indexOf(t);
    all[Math.max(0, Math.min(all.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))].focus();
  }
});

/* 明暗：跟系统，按钮切换后记在本机浏览器里 */
function setTheme(v) { if (v) document.documentElement.dataset.theme = v; else delete document.documentElement.dataset.theme; }
try { setTheme(localStorage.getItem("atrium-theme")); } catch (_) { /* 无痕窗口等读不到时跟系统 */ }
$("#theme").onclick = () => {
  const r = document.documentElement;
  const dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  setTheme(dark ? "light" : "dark");
  try { localStorage.setItem("atrium-theme", r.dataset.theme); } catch (_) { /* 同上 */ }
};

route();
const stream = new EventSource("/ui/stream");
stream.onerror = () => atriumLogo.connection(false);
stream.onopen = () => {
  const reconnected = atriumLogo.reconnecting;
  atriumLogo.connection(true);
  if (reconnected) refresh();
};
stream.onmessage = e => { if (e.data === "changed") refresh(); };
