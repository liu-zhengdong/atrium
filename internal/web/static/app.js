// Atrium 只读网页。地址：#today、#legion、#oN[/tasks|rules|files]；末段是 tN、cN、sN 或 aN（负责人，只在部门页）时打开抽屉。
// 数据只从 /ui/api/… 读；/ui/stream 推「changed」时重取当前页与抽屉，数据没变的一处不重画。
"use strict";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = {
  choose: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 8.5 6.5 12 13 4.5"/></svg>',
  accept: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/></svg>',
  stuck: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 4v5"/><circle cx="8" cy="11.8" r=".6" fill="currentColor"/></svg>',
  escalate: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 13V3.5M4 7.5l4-4 4 4"/></svg>',
  check: '<svg class="check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8.5 6.5 12 13 4.5"/></svg>',
  repeat: '<svg class="rep" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12.5 6.5A4.8 4.8 0 0 0 3.6 5.2M3.5 9.5a4.8 4.8 0 0 0 8.9 1.3"/><path d="M3.3 2.6v2.8h2.8M12.7 13.4v-2.8H9.9"/></svg>',
  refresh: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v2.8h-2.8"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
};

let nav = { depts: [], asks: 0 };
let sortMode = "部门";

// last：每个接口上次取到的数据。切页时先拿它画，新数据到了再换。
const last = new Map();
async function api(path) {
  const body = await (await fetch("/ui/api/" + path)).json();
  if (!body.ok) throw new Error(body.error?.message || "读取失败");
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
const deptName = id => nav.depts.find(d => d.id === id)?.name || id;

/* 地址 */
function parseHash() {
  const segs = location.hash.slice(1).split("/").filter(Boolean);
  let open = null;
  if (segs.length && /^[tcsa][1-9]\d*$/.test(segs[segs.length - 1])) open = segs.pop();
  return { page: segs[0] || "today", tab: segs[1] || "", open };
}
function hashWith(open) {
  const { page, tab } = parseHash();
  return "#" + [page, tab, open].filter(Boolean).join("/");
}

/* 列表行；depth 是在任务树里的层级（缩进），who 缺省用行自带的 */
function taskRow(r, timeFn = ago, depth = 0, who = r.who) {
  const lead = r.state === "done" ? icon.check : `<span class="dot ${esc(r.state)}"></span>`;
  return `<div class="row ${["done", "draft", "off"].includes(r.state) ? "done" : ""}" data-task="${esc(r.id)}" tabindex="0"${depth ? ` style="--d:${Math.min(depth, 4)}"` : ""}>
    ${lead}<div class="title"><span class="id">${esc(r.id)}</span>${esc(r.title)}</div>
    <div class="who">${esc(who)}</div><div class="time num">${esc(timeFn(r.at))}</div></div>`;
}

/* 周期任务一行：多久一轮写在行尾标签，下一轮写在时间列；暂停范围内写「暂停中」。窄屏时间列隐藏，改用下一轮顶替标签（见 app.css）。
   dept：部门页，下面挂上一轮（点开是那件任务）；today：今天页，不挂上一轮，只在出了问题时把问题写在行尾。 */
// 下一轮总写到钟点：窄屏只剩这一列，省了钟点就看不出几点跑。
const schedWhen = s => s.paused ? "暂停中" : ahead(s.next_at);
function schedRow(s, where, deptLabel = "") {
  const tag = [deptLabel, s.cadence, s.kind].filter(Boolean).join(" · ");
  const warn = where === "today" && s.trouble;
  const head = `<div class="row sched${warn ? " trouble" : ""}" data-sched="${esc(s.id)}" tabindex="0">${icon.repeat}
    <div class="title"><span class="id">${esc(s.id)}</span>${esc(s.title)}</div>
    <div class="who">${warn ? `<span class="warn">上一轮派活失败</span>` : esc(tag)}</div><div class="time num">${esc(schedWhen(s))}</div></div>`;
  if (where !== "dept" || !s.last) return head;
  const who = s.trouble ? `<span class="warn">派活失败</span>` : esc(s.last.who) + (s.skips ? ` · <span class="warn">跳过 ${s.skips} 轮</span>` : "");
  return head + taskRow({ ...s.last, title: "上一轮" }, ago, 1).replace(/<div class="who">.*?<\/div>/, `<div class="who">${who}</div>`);
}

/* 任务树：没结束的子任务都摆出来（卡在哪一件一眼可见）；结束的两件以上折成一行，点开再看。展开状态跨刷新保留。 */
const ended = r => r.state === "done" || r.state === "off";
const openKids = new Set();
function kidRows(kids, depth, key, rowFn) {
  const done = kids.filter(ended), rest = kids.filter(k => !ended(k));
  const fold = done.length > 1, open = openKids.has(key);
  return rest.map(k => rowFn(k, depth)).join("") + (fold
    ? `<button class="row kfold" data-kids="${esc(key)}" aria-expanded="${open}" style="--d:${Math.min(depth, 4)}"><span class="chev">›</span><div class="title">已结束 ${done.length} 件</div></button>`
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
    `${name ? `<div class="dept-h group-h"${name === "草稿" ? ' id="drafts"' : ""}>${name}<span class="num">${rs.length}</span></div>` : ""}<div class="rows">${rs.map(r => treeRow(r)).join("")}</div>`).join("");
}
/* 今天页脉搏行的「草稿 N」：点开到根部门任务页的草稿组 */
function draftsLink(n) {
  const root = nav.depts.find(d => !d.parent);
  if (!n) return "";
  return root ? ` · <a class="quiet" href="#${esc(root.id)}/tasks" data-drafts>草稿 ${n} 件</a>` : ` · 草稿 ${n} 件`;
}

/* 今天 */
function renderToday(d) {
  let live = "";
  if (!d.running.length) live = `<div class="empty">没有在做的</div>`;
  else if (sortMode === "部门") {
    const groups = new Map();
    d.running.forEach(r => { const g = r.group || ""; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); });
    live = [...groups].map(([g, rows]) =>
      `<div class="dept-h">${g ? `<a href="#${esc(g)}">${esc(deptName(g))}</a>` : "没归部门"}</div>${rows.map(r => taskRow(r)).join("")}`).join("");
  } else {
    live = [...d.running].sort((a, b) => a.at - b.at).map(r => taskRow(r)).join("");
  }
  const asks = d.asks.length ? `<div class="asks">${d.asks.map(a => `
      <button class="ask ${esc(a.kind)}" data-open="${esc(a.id)}">
        <span class="kind">${icon[a.kind]}</span>
        <span class="body"><span class="t">${esc(a.title)}</span><span class="s">${esc(a.sub)}</span></span>
        <span class="meta">${esc(a.dept_name || "")}<br>${esc(ago(a.at))}前</span>
      </button>`).join("")}</div>` : `<div class="empty">没有等你的事</div>`;
  $("#page").innerHTML = `
    <h1 class="hello">${d.paused.includes("all") ? "已全部暂停" : d.asks.length ? `${d.asks.length} 件事等你` : d.paused.length ? `部分暂停：${esc(d.paused.join("、"))}` : "军团在自己运转"}</h1>
    <p class="pulse-line"><span class="dot ${d.running.length ? "run" : "idle"}"></span>&nbsp; ${d.running.length} 件在做 · ${d.queued} 件排队 · 今天上线 ${d.shipped.length} 件${draftsLink(d.drafts)}</p>
    <section class="section"><h2>等你</h2>${asks}</section>
    <section class="section"><h2>在做${d.running.length > 1 ? `<button class="sort" id="sort">按${sortMode} ▾</button>` : ""}</h2><div class="rows">${live}</div></section>
    <section class="section"><h2>接下来 7 天</h2>${soonHTML(d.soon)}</section>
    ${d.shipped.length ? `<section class="section"><h2>今天上线</h2><div class="rows">${shippedRows(d.shipped)}</div></section>` : ""}
    <section class="section"><h2>三个目标</h2><dl class="facts"><dt>近 7 天</dt><dd>${esc(d.goals.week.text)}</dd><dt>累计</dt><dd>${esc(d.goals.all.text)}</dd></dl></section>`;
}

/* 今天上线：先摆最近 5 件，其余折成一行（与任务树里「已结束 N 件」同一种折法） */
const shipFold = 5;
function shippedRows(rows) {
  const open = openKids.has("shipped"), rest = rows.length - shipFold;
  return rows.slice(0, rest > 1 && !open ? shipFold : rows.length).map(r => taskRow(r, clock)).join("")
    + (rest > 1 ? `<button class="row kfold" data-kids="shipped" aria-expanded="${open}"><span class="chev">›</span><div class="title">${open ? "收起" : `还有 ${rest} 件`}</div></button>` : "");
}

/* 接下来 7 天：按一级部门分组，组内按下一轮先后；不在一级部门本身的，行尾带部门名 */
function soonHTML(soon) {
  if (!soon.rows.length) return `<div class="empty">7 天内没有定期的事</div>`;
  const groups = new Map();
  soon.rows.forEach(s => { if (!groups.has(s.group)) groups.set(s.group, []); groups.get(s.group).push(s); });
  return `<div class="rows">${[...groups].map(([g, rows]) => `<div class="dept-h"><a href="#${esc(g)}">${esc(deptName(g))}</a></div>`
    + rows.map(s => schedRow(s, "today", s.org !== g ? s.dept_name : "")).join("")).join("")}</div>`
    + (soon.later ? `<div class="more">另有 ${soon.later} 条在 7 天以后</div>` : "");
}

/* 部门；负责人一行只是入口，详情（执行者组合、负责哪些部门、备忘）开在抽屉里，数据就用这一页的 */
// 页头（上级路径与名字）取自侧栏的部门树：这页的数据还没到时也能先摆出来
function deptHead(id) {
  const up = [];
  for (let p = nav.depts.find(d => d.id === id)?.parent; p; p = nav.depts.find(d => d.id === p)?.parent) up.unshift(p);
  return `<div class="crumb">${up.map(p => `<a href="#${esc(p)}">${esc(deptName(p))}</a><span>/</span>`).join("")}</div>
    <h1 class="dept-title">${esc(deptName(id))}</h1>`;
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
  const sched = d.schedules.length ? `<section class="section"><h2>周期任务<span class="cap">${d.schedules.length}/${d.schedule_max}</span></h2>
    <div class="rows">${d.schedules.map(s => schedRow(s, "dept")).join("")}</div></section>` : "";
  let body = "";
  if (tab === "tasks") body = d.tasks.length ? taskGroups(d.tasks) : `<div class="empty">这个部门现在没有任务</div>`;
  if (tab === "rules") {
    const rule = (r, i) => `<div class="rule ${i === null ? "inh" : ""}"><span class="i">${i === null ? "·" : i + 1}</span>
      <span class="t">${esc(r.text)}${r.why ? `<span class="why">${esc(r.why)}</span>` : ""}</span>
      <span class="w">${esc(i === null ? r.dept_name : r.by)}</span></div>`;
    body = (d.rules.length ? d.rules.map((r, i) => rule(r, i)).join("") : `<div class="empty">本部门没有自己的规矩</div>`) +
      (d.inherited.length ? `<div class="inh-h">从上级继承</div>${d.inherited.map(r => rule(r, null)).join("")}` : "");
  }
  if (tab === "files") body = d.materials.length ? `<div class="rows">${d.materials.map(m => `
    <div class="row still"><span class="dot idle"></span><div class="title"><span class="id">${esc(m.id)}</span>${esc(m.title)}</div>
    <div class="who">${m.kind === "overview" ? "总览 · " : ""}v${m.rev} · ${size(m.size)}</div><div class="time num">${date(m.created_at)}</div></div>`).join("")}</div>`
    : `<div class="empty">还没有资料</div>`;
  const cap = d.rules.length > d.rule_max ? "cap over" : "cap";
  const used = d.materials.reduce((n, m) => n + m.units, 0);
  $("#page").innerHTML = `
    ${deptHead(id)}
    ${dept.what ? `<p class="dept-what">${esc(dept.what)}</p>` : ""}
    ${intro.length ? `<dl class="intro">${intro.map(x => `<dt>${x[0]}</dt><dd>${esc(x[1])}</dd>`).join("")}</dl>` : ""}
    ${d.leader ? `<button class="lead" data-open="${esc(d.leader.id)}"><b>${esc([...d.leader.name][0] || "负")}</b>${esc(d.leader.name)}${d.leader.inherited ? "（上级）" : ""}<span class="chev">›</span></button>` : `<div class="lead"><b>你</b>你直接管<span>秘书帮你盯着</span></div>`}
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

/* 执行者。额度是现读的：先摆上次读数，标题旁转一个小刷新图标，读到就换；读不到留着上次读数，每行写上读的时刻 */
// 转圈的图标直接加到标题上、读完直接拿掉，不为它重画整页（推送一来就读一次）
let quotaReading = null, quotaErr = "";
const spin = `<span class="spin" title="正在读">${icon.refresh}</span>`;
function readQuota() {
  if (quotaReading) return;
  quotaErr = "";
  $("#quota-h")?.insertAdjacentHTML("beforeend", spin);
  quotaReading = api("quota").then(q => { const d = last.get("legion"); if (d) Object.assign(d, q); })
    .catch(err => { quotaErr = err.message; })
    .finally(() => { quotaReading = null; $("#quota-h .spin")?.remove(); if (parseHash().page === "legion") showPage(); });
}
const readAt = ms => (day(ms) === "今天" ? "" : date(ms) + " ") + clock(ms) + " 的读数";
function renderLegion(d) {
  const reserve = d.reserve;
  const accts = d.accounts.length ? `<div class="accts">${d.accounts.map(a => {
    const left = a.left ?? 0;
    const note = [a.note, (a.stale || quotaErr) && a.at ? readAt(a.at) : ""].filter(Boolean).join(" · ");
    return `<div class="acct"><span>${esc(a.name)}</span><div class="bar"><i style="width:${left}%;${left < 20 ? "background:var(--wait)" : ""}"></i><span class="reserve" style="width:${reserve}%"></span></div>
    <span class="r">${a.left === null ? esc(a.note || "没有读数") : `剩 <span class="num">${a.left}%</span>${note ? " · " + esc(note) : ""}`}</span></div>`;
  }).join("")}</div>` : `<div class="empty">还没有额度读数</div>`;
  const reading = quotaReading ? spin : quotaErr ? `<span class="qerr">读不到：${esc(quotaErr)}</span>` : "";
  const hosts = d.hosts.length ? `<div class="hosts">${d.hosts.map(h => `
    <div class="host"><div class="n"><span class="dot ${h.online ? (h.busy ? "run" : "idle") : "off"}"></span><span class="id">${esc(h.id)}</span>${esc(h.name)}</div>
    <div class="s">${esc(h.status)} · ${h.busy}/${h.slots} 在用</div>
    <div class="slots">${Array.from({ length: Math.min(h.slots, 32) }, (_, i) => `<i class="${i < h.busy ? "on" : ""}"></i>`).join("")}</div></div>`).join("")}</div>`
    : `<div class="empty">还没有登记机器</div>`;
  const outName = { ok: "交付", bounce: "被交回", quota: "额度", setup: "起不来", fail: "其他失败" };
  const markText = m => `${m.host} ${m.reason} · ${m.until ? day(m.until) + " " + clock(m.until) + " 恢复" : "等人处理"}`;
  const perf = d.perf.length ? `<div class="tablewrap"><table class="perf"><tr><th>组合</th><th>近 ${d.window} 次拉起，新的在左</th><th>交付</th></tr>${d.perf.map(p => `
    <tr><td>${esc(p.combo)}${p.marks.map(m => `<span class="mark">${esc(markText(m))}</span>`).join("")}</td><td><span class="pips runs">${p.recent.map(o => `<i class="${o}" title="${outName[o]}"></i>`).join("")}</span></td><td class="num">${p.launches ? p.ok + "/" + p.launches : ""}</td></tr>`).join("")}</table>
    <div class="legend"><i class="ok"></i>交付<i class="bounce"></i>被交回<i class="fail"></i>没拉起来（额度、起不来、其他）</div></div>`
    : `<div class="empty">还没有拉起记录</div>`;
  $("#page").innerHTML = `<h1 class="hello">执行者</h1>
  <p class="pulse-line">派活按额度富余挑人${reserve ? `，斜线部分是给你自己留的 ${reserve}%` : ""}。</p>
  <section class="section"><h2 id="quota-h">额度${reading}</h2>${accts}</section>
  <section class="section"><h2>机器</h2>${hosts}</section>
  <section class="section"><h2>表现</h2>${perf}</section>`;
}

/* 经过：按执行者说的话分段；命令显示原文，点开看完整命令与输出最后 30 行。展开状态跨刷新保留。 */
const unfolded = new Set();
const md = s => esc(s).replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  .replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
const firstPara = s => s.trim().split(/\n\s*\n/)[0];
const oneLine = s => s.trim().replace(/\s*\n\s*/g, " ↵ ");
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
    return `<div class="cmd ${c.state}"><button data-c="${k}" aria-expanded="${o}"><span class="lbl">${esc(oneLine(c.cmd))}</span><span class="st">${cmdNote[c.state]}</span></button>
      ${o ? `<div class="detail"><div class="c">$ ${esc(c.cmd)}</div>${c.state === "run" ? "" : `<div class="o">${esc(c.out) || "（没有输出）"}</div>`}</div>` : ""}</div>`;
  }).join("")}</div>` : "";
  return `<div class="phase ${running ? "run" : ""}"><span class="pd"></span><div>
    ${s.say ? `<div class="say">${md(s.say)}</div>` : `<div class="say quiet">先看代码</div>`}
    ${cmds.length ? `<button class="grp" data-g="${key}" aria-expanded="${exp}"><span class="chev">›</span>${cmds.length} 条命令${pips(cmds)}</button>` : ""}
    ${running && !exp && last?.state === "run" ? `<div class="nowrun">正在跑：<code>${esc(oneLine(last.cmd).slice(0, 60))}</code></div>` : ""}${list}</div></div>`;
}
function traceHTML(d) {
  const tr = d.trace;
  if (!tr) return "";
  const tid = d.task.id, segs = tr.segments, n = cmdsOf(segs).length;
  const lines = (tr.unknown ? `<div class="jh"><b>没认出</b><span>${tr.unknown} 行事件，工具的日志格式可能变了</span></div>` : "")
    + (tr.lines?.length ? `<div class="log">${esc(tr.lines.join("\n"))}</div>` : "");
  const fold = (key, label, open) => `<button class="grp fold" data-g="${tid}:${key}" aria-expanded="${open}"><span class="chev">›</span><span>${label}</span></button>`;
  if (!segs.length && !tr.ended) return lines ? `<div class="jh"><b>日志</b></div>${lines}` : "";
  if (d.live) { // 进行中：只留最近两段，当前段展开，更早的折起
    const older = segs.slice(0, Math.max(0, segs.length - 2)), showOld = unfolded.has(tid + ":old");
    return `<div class="jh"><b>经过</b><span>${n} 条命令 · 已跑 ${since(d.run_at)}</span></div>`
      + (older.length ? fold("old", `前面还有 ${tally(older)}`, showOld) : "")
      + (showOld ? older.map((s, i) => segHTML(tid, s, i, false)).join("") : "")
      + segs.slice(older.length).map((s, k) => segHTML(tid, s, older.length + k, older.length + k === segs.length - 1)).join("") + lines;
  }
  let out = "";
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
  const rel = r => taskRow(r, ago, 0, r.dept && r.dept !== org ? `${r.who ? r.who + " · " : ""}${deptName(r.dept)}` : r.who);
  const part = (name, rows, note = "") => rows.length ? `<div class="jh"><b>${name}</b>${note ? `<span>${note}</span>` : ""}</div><div class="rows">${rows}</div>` : "";
  const done = d.kids.filter(r => r.state === "done").length;
  return part("子任务", kidRows(d.kids, 0, "d:" + d.task.id, r => rel(r)), d.kids.length ? `${done}/${d.kids.length} 完成` : "")
    + part("要等", d.waits.map(rel).join(""))
    + part("在等它", d.waiters.map(rel).join(""));
}

/* 抽屉：头部写短号与部门，同一件东西重画时保留滚动位置（推送一来就重画，读长文不能跳回顶） */
let drawerId = "";
function drawer(id, head, body) {
  const keep = drawerId === id ? $("#drawer .dbody")?.scrollTop || 0 : 0;
  drawerId = id;
  $("#drawer").innerHTML = `<div class="dhead"><span class="id">${esc(head)}</span><button class="x" data-close aria-label="关闭">${icon.x}</button></div>
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
  const pr = !t.pr ? "还没有" : /^https?:\/\//.test(t.pr) ? `<a href="${esc(t.pr)}" target="_blank" rel="noreferrer">${esc(t.pr.replace(/^.*\/pull\//, "#"))}</a>` : esc(t.pr);
  const draft = d.state === "draft";
  const label = stuck ? "卡住" : draft ? "草稿" : d.state === "done" ? "完成" : d.state === "off" ? "取消" : "现在";
  drawer(t.id, [t.id, d.dept_name].filter(Boolean).join(" · "), `
      ${d.parent ? `<div class="crumb up"><a href="${esc(hashWith(d.parent.id))}"><span class="id">${esc(d.parent.id)}</span>${esc(d.parent.title)}</a><span>/</span></div>` : ""}
      <h3>${esc(t.title)}</h3>
      ${draft ? "" : `<div class="steps">${d.steps.map((s, i) => `<div class="step ${i < d.step ? "past" : i === d.step ? "now" + (stuck ? " stuck" : "") : ""}"><i></i>${s}</div>`).join("")}</div>`}
      <div class="holder"><b>${label}</b>　${esc(draft ? "还没想清楚，不派活、不计时" : d.holder)} · ${esc(ago(t.updated_at))}</div>
      ${draft ? `<p class="draft-detail">${t.detail ? esc(t.detail) : "没有详述"}</p>` : `<dl class="facts"><dt>执行者</dt><dd>${esc(t.worker || "还没派")}</dd><dt>机器</dt><dd>${t.host ? esc(t.host + (d.host_name ? " " + d.host_name : "")) : "还没派"}</dd><dt>PR</dt><dd>${pr}</dd>${t.skill ? `<dt>技能</dt><dd>${esc(t.skill)}</dd>` : ""}${d.schedule ? `<dt>来自</dt><dd><a href="${esc(hashWith(d.schedule))}">周期任务 ${esc(d.schedule)}</a></dd>` : ""}${d.choice ? `<dt>选项单</dt><dd><a href="${esc(hashWith(d.choice))}">${esc(d.choice)}</a></dd>` : ""}</dl>`}
      ${t.source || t.class ? `<dl class="facts"><dt>来源</dt><dd>${esc(sourceLabel[t.source] || "没写")}${byHTML(d)}</dd><dt>类</dt><dd>${esc(t.class || "没归类")}</dd></dl>` : ""}
      ${relHTML(d)}
      ${traceHTML(d)}`);
}
function renderChoice(c) {
  const status = c.status === "open" ? "" : c.status === "picked" ? "已拍板" : "这轮都不做";
  const rec = new Set(c.recommend || []);
  drawer(c.id, [c.id, c.dept_name].filter(Boolean).join(" · "), `<h3>${esc(c.title)}</h3><p class="sub-t">${c.task ? "出自 " + esc(c.task) + " · " : ""}${esc(ago(c.created_at))}前${status ? " · " + status : ""}</p>
      ${c.reason ? `<p class="status-line">${esc(c.reason)}</p>` : ""}
      <div class="opts">${c.options.map(o => `
        <div class="opt ${o.task ? "on" : ""}">
          <span class="num" style="color:var(--ink3);font-size:13px;line-height:22px">${o.pos}</span>
          <div><div class="t">${esc(o.title)}${rec.has(o.pos) ? '<span class="rec">推荐</span>' : ""}${o.task ? `<span class="pick">已选 · ${esc(o.task)}</span>` : ""}</div>
          <div class="g">${esc(o.gain)}</div>
          <div class="cost">${esc(o.cost)}</div>
          ${o.why_now || o.if_not ? `<details><summary>为什么现在</summary><div class="whyt">${esc(o.why_now)}${o.if_not ? `<br>不做：${esc(o.if_not)}` : ""}</div></details>` : ""}</div></div>`).join("")}</div>
      ${c.note ? `<p class="status-line">${esc(c.note)}</p>` : ""}
      ${c.status === "open" ? `<p class="status-line">选哪几个，在终端里告诉秘书。</p>` : ""}`);
}
/* 周期任务抽屉：下一轮的完整时刻、每轮做什么、最近几轮（点开是那件任务）、最近一笔记录，详述折起 */
const kindDoes = { "调研": "写一张选项单给你挑", "体验巡检": "把主路径走一遍，能修的开 PR" };
function renderSchedule(s) {
  const w = ahead(s.next_at), next = new Date(s.next_at);
  const when = s.paused ? "暂停中：到点不生成，恢复后只补一轮"
    : /^\d\d-/.test(w) ? `${w} ${clock(s.next_at)}` : `${/^\d\d:/.test(w) ? "今天 " : ""}${w}（${pad(next.getMonth() + 1)}-${pad(next.getDate())}）`;
  const facts = [["每轮", kindDoes[s.kind] || firstPara(s.detail)], ["技能", s.skill]].filter(x => x[1]);
  const day = r => (r.title.match(/（(\d\d-\d\d)）$/) || [])[1];
  drawer(s.id, s.id + " · " + s.dept_name, `<h3>${esc(s.title)}</h3>
      <p class="sub-t">${esc([s.cadence, s.kind].filter(Boolean).join(" · "))} · ${esc({ secretary: "秘书", u1: "你" }[s.by] || s.by)} ${esc(date(s.created_at))} 建</p>
      <div class="holder"><b>下一轮</b>　${esc(when)}</div>
      ${facts.length ? `<dl class="facts">${facts.map(f => `<dt>${f[0]}</dt><dd>${esc(f[1])}</dd>`).join("")}</dl>` : ""}
      <div class="jh"><b>最近几轮</b>${s.skips ? `<span>跳过过 ${s.skips} 轮</span>` : ""}</div>
      ${s.rounds.length ? `<div class="rows">${s.rounds.map(r => taskRow({ ...r, title: day(r) ? day(r) + " 这一轮" : r.title })).join("")}</div>` : `<div class="quiet-line">还没跑过</div>`}
      ${s.note ? `<p class="status-line${s.trouble ? " warn" : ""}">${esc(s.note)}</p>` : ""}
      ${s.detail ? `<details class="full"><summary>详述</summary><div class="result">${md(s.detail.trim())}</div></details>` : ""}`);
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
  drawer(l.id, l.id + " · 负责人", `<h3>${esc(l.name)}</h3>
    ${l.inherited ? `<p class="sub-t">${esc(deptPage.dept.name)}没有自己的负责人，由上级的这一位管</p>` : ""}
    <dl class="facts"><dt>执行者</dt><dd>${esc(l.workers)}</dd>
      <dt>负责</dt><dd>${l.depts.map(p => `<a href="#${esc(p.id)}">${esc(p.name)}</a>`).join("、")}</dd></dl>
    <div class="jh"><b>备忘</b><span class="num">${n}/${deptPage.memo_max} 字</span></div>
    ${n ? `<div class="memo">${memoHTML(l.memo)}</div>` : `<div class="quiet-line">还没写备忘</div>`}`);
}
function openDrawer() {
  if ($("#island").classList.contains("open")) return;
  $("#island").classList.add("open");
  setTimeout(() => $("#drawer").focus(), 50);
}
function closeDrawer() { $("#island").classList.remove("open"); drawerId = shownDrawer = ""; }

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
  return { path: "today", head: `<div class="skel"><i class="t"></i></div>`, draw: renderToday };
}
function drawerOf(open, page) {
  if (open[0] === "a") return { path: "dept/" + page, draw: d => renderLeader(d, open) }; // 负责人抽屉用部门页的数据
  const [path, draw] = { c: ["choice/", renderChoice], s: ["schedule/", renderSchedule] }[open[0]] || ["task/", renderTask];
  return { path: path + open, draw };
}
// 骨架：这一页还没取到过数据时先占住版面（慢于 0.15 秒才淡入，数据很快到时不闪）
const skeleton = `<div class="skel">${`<section class="section"><i class="h"></i>${"<i></i>".repeat(4)}</section>`.repeat(2)}</div>`;
let shownPage = "", shownKey = "", shownDrawer = "";
function showPage(force) {
  const { page, tab } = parseHash(), p = pageOf(page, tab), d = last.get(p.path);
  const key = page + "/" + tab + JSON.stringify(d ?? null) + (page === "legion" ? quotaErr : "");
  if (key === shownKey && !force) return;
  const top = page === shownPage ? $("#scroll").scrollTop : 0; // 换了页回到顶，同一页（含换页签）保留滚动
  shownPage = page; shownKey = key;
  if (d) p.draw(d); else $("#page").innerHTML = p.head + skeleton;
  $("#scroll").scrollTop = top;
}
function showDrawer(open, page) {
  const dr = drawerOf(open, page), d = last.get(dr.path), key = open + JSON.stringify(d ?? null);
  if (key === shownDrawer) return;
  shownDrawer = key;
  if (d) dr.draw(d); else drawer(open, open, skeleton);
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
    if (page === "legion") readQuota();
    showPage();
    if (open) { showDrawer(open, page); openDrawer(); } else closeDrawer();
    await Promise.all([...new Set(["nav", pageOf(page, tab).path, open && drawerOf(open, page).path])].filter(Boolean).map(api));
    if (n !== seq) return; // 等的时候又点了别处：由新的那次来画
    nav = last.get("nav");
    renderTree(page);
    showPage();
    if (open) showDrawer(open, page);
    if (toDrafts) { toDrafts = false; $("#drafts")?.scrollIntoView({ block: "start" }); }
    if (open?.[0] === "t" && last.get("task/" + open).live) liveTimer = setTimeout(refresh, 5000); // 执行者在干时日志一直在长，抽屉每 5 秒重取
  } catch (err) { if (n === seq) fail(err); }
}
function refresh() {
  clearTimeout(rendering);
  rendering = setTimeout(route, 250);
}

addEventListener("hashchange", route);
$("#mnav").onchange = e => { location.hash = e.target.value; };
document.addEventListener("click", e => {
  if (e.target.closest("[data-drafts]")) toDrafts = true;
  if (e.target.closest("#sort")) { sortMode = sortMode === "部门" ? "用时" : "部门"; return showPage(true); }
  const tb = e.target.closest("[data-tab]"); if (tb) { location.hash = parseHash().page + "/" + tb.dataset.tab; return; }
  const fold = e.target.closest("#drawer [data-g]");
  if (fold) {
    const k = fold.dataset.g;
    if (fold.getAttribute("aria-expanded") === "true") { unfolded.delete(k); unfolded.add(k + ":closed"); }
    else { unfolded.add(k); unfolded.delete(k + ":closed"); }
    return renderTask(drawerTask);
  }
  const kf = e.target.closest("[data-kids]");
  if (kf) {
    const k = kf.dataset.kids;
    openKids.has(k) ? openKids.delete(k) : openKids.add(k);
    return kf.closest("#drawer") ? renderTask(drawerTask) : showPage(true);
  }
  const cmd = e.target.closest("#drawer [data-c]");
  if (cmd) { const k = cmd.dataset.c; unfolded.has(k) ? unfolded.delete(k) : unfolded.add(k); return renderTask(drawerTask); }
  const t = e.target.closest("[data-task]"); if (t) { location.hash = hashWith(t.dataset.task); return; }
  const sc = e.target.closest("[data-sched]"); if (sc) { location.hash = hashWith(sc.dataset.sched); return; }
  const a = e.target.closest("[data-open]"); if (a) { location.hash = hashWith(a.dataset.open); return; }
  const g = e.target.closest("[data-go]"); if (g) { location.hash = g.dataset.go; return; }
  if (e.target.closest("[data-close]") || e.target.id === "scrim") location.hash = hashWith(null);
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && parseHash().open) location.hash = hashWith(null);
  const sc = e.target.closest?.("[data-sched]");
  if (sc && e.key === "Enter") location.hash = hashWith(sc.dataset.sched);
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
new EventSource("/ui/stream").onmessage = e => { if (e.data === "changed") refresh(); };
