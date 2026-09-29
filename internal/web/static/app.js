// Atrium 只读网页。地址：#today、#legion、#oN[/tasks|rules|files]；末段是 tN 或 cN 时打开抽屉。
// 数据只从 /ui/api/… 读；/ui/stream 推「changed」时重取当前页与抽屉。
"use strict";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = {
  choose: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 8.5 6.5 12 13 4.5"/></svg>',
  accept: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/></svg>',
  stuck: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 4v5"/><circle cx="8" cy="11.8" r=".6" fill="currentColor"/></svg>',
  escalate: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 13V3.5M4 7.5l4-4 4 4"/></svg>',
  check: '<svg class="check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8.5 6.5 12 13 4.5"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
};

let nav = { depts: [], asks: 0 };
let sortMode = "部门";

async function api(path) {
  const body = await (await fetch("/ui/api/" + path)).json();
  if (!body.ok) throw new Error(body.error?.message || "读取失败");
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
const clock = ms => { const t = new Date(ms); return pad(t.getHours()) + ":" + pad(t.getMinutes()); };
function size(n) {
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + " MB";
  if (n >= 1 << 10) return Math.round(n / (1 << 10)) + " KB";
  return n + " B";
}
const deptName = id => nav.depts.find(d => d.id === id)?.name || id;

/* 地址 */
function parseHash() {
  const segs = location.hash.slice(1).split("/").filter(Boolean);
  let open = null;
  if (segs.length && /^[tc][1-9]\d*$/.test(segs[segs.length - 1])) open = segs.pop();
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
async function renderToday() {
  const d = await api("today");
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
    <section class="section"><h2>在做${d.running.length > 1 ? `<button class="sort" id="sort">按${sortMode} ▾</button>` : ""}</h2><div class="rows">${live}</div>
      ${d.shipped.length ? `<div class="dept-h" style="padding-top:18px">今天上线</div><div class="rows">${d.shipped.map(r => taskRow(r, clock)).join("")}</div>` : ""}
    </section>
    <section class="section"><h2>三个目标</h2><dl class="facts"><dt>近 7 天</dt><dd>${esc(d.goals.week.text)}</dd><dt>累计</dt><dd>${esc(d.goals.all.text)}</dd></dl></section>`;
  const sort = $("#sort");
  if (sort) sort.onclick = () => { sortMode = sortMode === "部门" ? "用时" : "部门"; renderToday().catch(fail); };
}

/* 部门 */
async function renderDept(id, tab) {
  const d = await api("dept/" + id);
  tab = ["tasks", "rules", "files"].includes(tab) ? tab : "tasks";
  const dept = d.dept;
  const subCards = d.subs.map(s => {
    const st = s.stuck ? "bad" : s.running ? "run" : "idle";
    const c = [s.running ? s.running + " 件在做" : "", s.stuck ? s.stuck + " 件卡住" : ""].filter(Boolean).join(" · ") || "没有在做的";
    return `<button class="sub" data-go="${esc(s.id)}"><span class="n"><span class="dot ${st}"></span>${esc(s.name)}</span>
      <span class="w">${esc(s.what)}</span><span class="c">${esc(c)}</span></button>`;
  }).join("");
  const intro = [["怎么用", dept.uses], ["现状", dept.now], ["下一步", dept.next]].filter(x => x[1]);
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
    <div class="row"><span class="dot idle"></span><div class="title"><span class="id">${esc(m.id)}</span>${esc(m.title)}</div>
    <div class="who">${m.kind === "overview" ? "总览 · " : ""}v${m.rev} · ${size(m.size)}</div><div class="time num">${date(m.created_at)}</div></div>`).join("")}</div>`
    : `<div class="empty">还没有资料</div>`;
  const cap = d.rules.length > d.rule_max ? "cap over" : "cap";
  $("#page").innerHTML = `
    <div class="crumb">${d.path.map(p => `<a href="#${esc(p.id)}">${esc(p.name)}</a><span>/</span>`).join("")}</div>
    <h1 class="dept-title">${esc(dept.name)}</h1>
    ${dept.what ? `<p class="dept-what">${esc(dept.what)}</p>` : ""}
    ${intro.length ? `<dl class="intro">${intro.map(x => `<dt>${x[0]}</dt><dd>${esc(x[1])}</dd>`).join("")}</dl>` : ""}
    ${d.leader ? `<div class="lead"><b>${esc([...d.leader.name][0] || "负")}</b>${esc(d.leader.name)}${d.leader.inherited ? "（上级）" : ""}<span>${esc(d.leader.workers)}</span></div>`
      : `<div class="lead"><b>你</b>你直接管<span>秘书帮你盯着</span></div>`}
    ${d.subs.length ? `<section class="section"><h2>下属部门</h2><div class="subs">${subCards}</div></section>` : ""}
    <section class="section">
      <div class="tabs">
        <button data-tab="tasks" class="${tab === "tasks" ? "on" : ""}">任务</button>
        <button data-tab="rules" class="${tab === "rules" ? "on" : ""}">规矩</button>
        <button data-tab="files" class="${tab === "files" ? "on" : ""}">资料</button>
        ${tab === "rules" ? `<span class="${cap}">${d.rules.length > d.rule_max ? "超限 " : ""}${d.rules.length}/${d.rule_max}</span>` : ""}
      </div>${body}</section>`;
  document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { location.hash = id + "/" + b.dataset.tab; });
}

/* 执行者 */
async function renderLegion() {
  const d = await api("legion");
  const reserve = d.reserve;
  const accts = d.accounts.length ? d.accounts.map(a => {
    const left = a.left ?? 0;
    return `<div class="acct"><span>${esc(a.name)}</span><div class="bar"><i style="width:${left}%;${left < 20 ? "background:var(--wait)" : ""}"></i><span class="reserve" style="width:${reserve}%"></span></div>
    <span class="r">${a.left === null ? esc(a.note || "没有读数") : `剩 <span class="num">${a.left}%</span>${a.note ? " · " + esc(a.note) : ""}`}</span></div>`;
  }).join("") : `<div class="empty">还没有额度读数</div>`;
  const hosts = d.hosts.length ? `<div class="hosts">${d.hosts.map(h => `
    <div class="host"><div class="n"><span class="dot ${h.online ? (h.busy ? "run" : "idle") : "off"}"></span><span class="id">${esc(h.id)}</span>${esc(h.name)}</div>
    <div class="s">${esc(h.status)} · ${h.busy}/${h.slots} 在用</div>
    <div class="slots">${Array.from({ length: Math.min(h.slots, 32) }, (_, i) => `<i class="${i < h.busy ? "on" : ""}"></i>`).join("")}</div></div>`).join("")}</div>`
    : `<div class="empty">还没有登记机器</div>`;
  const perf = d.perf.length ? `<div class="tablewrap"><table class="perf"><tr><th>组合</th><th>交付</th><th>一次通过</th></tr>${d.perf.map(p => `
    <tr><td>${esc(p.worker)}</td><td class="num">${p.delivered}</td><td><span class="pass"><span class="bar"><i style="width:${p.first_pass}%;${p.first_pass < 60 ? "background:var(--wait)" : ""}"></i></span><span class="num">${p.first_pass}%</span></span></td></tr>`).join("")}</table></div>`
    : `<div class="empty">还没有完成的任务</div>`;
  $("#page").innerHTML = `<h1 class="hello">执行者</h1>
  <p class="pulse-line">派活按额度富余挑人${reserve ? `，斜线部分是给你自己留的 ${reserve}%` : ""}。</p>
  <section class="section"><h2>额度</h2>${accts}</section>
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

/* 抽屉 */
const sourceLabel = { user: "用户纠正", org: "组织发现" };
let drawerTask = null, liveTimer = null;
async function openTask(id) {
  const d = await api("task/" + id);
  clearTimeout(liveTimer);
  if (d.live) liveTimer = setTimeout(refresh, 5000); // 执行者在干时日志一直在长，抽屉每 5 秒重取
  renderTask(d);
}
function renderTask(d) {
  const body = $("#drawer .dbody"), keep = body && drawerTask?.task.id === d.task.id ? body.scrollTop : 0;
  drawerTask = d;
  const t = d.task;
  const stuck = d.state === "bad";
  const pr = !t.pr ? "还没有" : /^https?:\/\//.test(t.pr) ? `<a href="${esc(t.pr)}" target="_blank" rel="noreferrer">${esc(t.pr.replace(/^.*\/pull\//, "#"))}</a>` : esc(t.pr);
  const draft = d.state === "draft";
  const label = stuck ? "卡住" : draft ? "草稿" : d.state === "done" ? "完成" : d.state === "off" ? "取消" : "现在";
  $("#drawer").innerHTML = `
    <div class="dhead"><span class="id">${esc(t.id)}</span>${d.dept_name ? `<span class="id">· ${esc(d.dept_name)}</span>` : ""}<button class="x" data-close aria-label="关闭">${icon.x}</button></div>
    <div class="dbody">
      ${d.parent ? `<div class="crumb up"><a href="${esc(hashWith(d.parent.id))}"><span class="id">${esc(d.parent.id)}</span>${esc(d.parent.title)}</a><span>/</span></div>` : ""}
      <h3>${esc(t.title)}</h3>
      ${draft ? "" : `<div class="steps">${d.steps.map((s, i) => `<div class="step ${i < d.step ? "past" : i === d.step ? "now" + (stuck ? " stuck" : "") : ""}"><i></i>${s}</div>`).join("")}</div>`}
      <div class="holder"><b>${label}</b>　${esc(draft ? "还没想清楚，不派活、不计时" : d.holder)} · ${esc(ago(t.updated_at))}</div>
      ${draft ? `<p class="draft-detail">${t.detail ? esc(t.detail) : "没有详述"}</p>` : `<dl class="facts"><dt>执行者</dt><dd>${esc(t.worker || "还没派")}</dd><dt>机器</dt><dd>${t.host ? esc(t.host + (d.host_name ? " " + d.host_name : "")) : "还没派"}</dd><dt>PR</dt><dd>${pr}</dd></dl>`}
      ${t.source || t.class ? `<dl class="facts"><dt>来源</dt><dd>${esc(sourceLabel[t.source] || "没写")}</dd><dt>类</dt><dd>${esc(t.class || "没归类")}</dd></dl>` : ""}
      ${relHTML(d)}
      ${traceHTML(d)}
    </div>`;
  $("#drawer .dbody").scrollTop = keep;
}
async function openChoice(id) {
  const c = await api("choice/" + id);
  const status = c.status === "open" ? "" : c.status === "picked" ? "已拍板" : "这轮都不做";
  const rec = new Set(c.recommend || []);
  $("#drawer").innerHTML = `
    <div class="dhead"><span class="id">${esc(c.id)}${c.dept_name ? " · " + esc(c.dept_name) : ""}</span><button class="x" data-close aria-label="关闭">${icon.x}</button></div>
    <div class="dbody"><h3>${esc(c.title)}</h3><p class="sub-t">${c.task ? "出自 " + esc(c.task) + " · " : ""}${esc(ago(c.created_at))}前${status ? " · " + status : ""}</p>
      ${c.reason ? `<p class="status-line">${esc(c.reason)}</p>` : ""}
      <div class="opts">${c.options.map(o => `
        <div class="opt ${o.task ? "on" : ""}">
          <span class="num" style="color:var(--ink3);font-size:13px;line-height:22px">${o.pos}</span>
          <div><div class="t">${esc(o.title)}${rec.has(o.pos) ? '<span class="rec">推荐</span>' : ""}${o.task ? `<span class="pick">已选 · ${esc(o.task)}</span>` : ""}</div>
          <div class="g">${esc(o.gain)}</div>
          <div class="cost">${esc(o.cost)}</div>
          ${o.why_now || o.if_not ? `<details><summary>为什么现在</summary><div class="whyt">${esc(o.why_now)}${o.if_not ? `<br>不做：${esc(o.if_not)}` : ""}</div></details>` : ""}</div></div>`).join("")}</div>
      ${c.note ? `<p class="status-line">${esc(c.note)}</p>` : ""}
      ${c.status === "open" ? `<p class="status-line">选哪几个，在终端里告诉秘书。</p>` : ""}
    </div>`;
}
function openDrawer() { $("#island").classList.add("open"); setTimeout(() => $("#drawer").focus(), 50); }
function closeDrawer() { $("#island").classList.remove("open"); }

/* 侧栏 */
function renderTree(cur) {
  const kids = id => nav.depts.filter(d => (d.parent || "") === id);
  const onPath = new Set();
  for (let id = cur; id; id = nav.depts.find(d => d.id === id)?.parent) onPath.add(id);
  const item = (d, l) => `<a href="#${esc(d.id)}" class="${cur === d.id ? "on" : ""}" style="padding-left:${8 + 16 * l}px">${esc(d.name)}${d.stuck ? '<span class="dot bad" title="有卡住的任务"></span>' : ""}</a>`;
  const walk = (parent, l) => kids(parent).map(d =>
    item(d, l) + (l === 0 || onPath.has(d.id) ? walk(d.id, l + 1) : "")).join("");
  $("#tree").innerHTML = walk("", 0) || `<div class="group">还没有部门</div>`;
  document.querySelectorAll("[data-nav]").forEach(a => a.classList.toggle("on", a.dataset.nav === cur));
  const count = $("#askCount");
  count.textContent = nav.asks;
  count.hidden = !nav.asks;
  $("#mnav").innerHTML = [["today", "今天"], ["legion", "执行者"], ...nav.depts.map(d => [d.id, "部门 · " + d.name])]
    .map(o => `<option value="${esc(o[0])}" ${o[0] === cur ? "selected" : ""}>${esc(o[1])}</option>`).join("");
}

/* 路由 */
function fail(err) {
  $("#page").innerHTML = `<div class="empty">读取失败：${esc(err.message)}</div>`;
}
let rendering = null;
let toDrafts = false; // 从今天页的「草稿 N 件」进来：渲染完滚到草稿组
async function route(keepScroll) {
  const { page, tab, open } = parseHash();
  const scroll = $("#scroll").scrollTop;
  try {
    nav = await api("nav");
    renderTree(page);
    if (page === "legion") await renderLegion();
    else if (/^o[1-9]\d*$/.test(page)) await renderDept(page, tab);
    else await renderToday();
    if (keepScroll) $("#scroll").scrollTop = scroll;
    if (toDrafts) { toDrafts = false; $("#drafts")?.scrollIntoView({ block: "start" }); }
    if (open) {
      await (open[0] === "c" ? openChoice(open) : openTask(open));
      if (!$("#island").classList.contains("open")) openDrawer();
    } else closeDrawer();
  } catch (err) { fail(err); }
}
function refresh() {
  clearTimeout(rendering);
  rendering = setTimeout(() => route(true), 250);
}

addEventListener("hashchange", () => route(false));
$("#mnav").onchange = e => { location.hash = e.target.value; };
document.addEventListener("click", e => {
  if (e.target.closest("[data-drafts]")) toDrafts = true;
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
    return kf.closest("#drawer") ? renderTask(drawerTask) : route(true);
  }
  const cmd = e.target.closest("#drawer [data-c]");
  if (cmd) { const k = cmd.dataset.c; unfolded.has(k) ? unfolded.delete(k) : unfolded.add(k); return renderTask(drawerTask); }
  const t = e.target.closest("[data-task]"); if (t) { location.hash = hashWith(t.dataset.task); return; }
  const a = e.target.closest("[data-open]"); if (a) { location.hash = hashWith(a.dataset.open); return; }
  const g = e.target.closest("[data-go]"); if (g) { location.hash = g.dataset.go; return; }
  if (e.target.closest("[data-close]") || e.target.id === "scrim") location.hash = hashWith(null);
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && parseHash().open) location.hash = hashWith(null);
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

route(false);
new EventSource("/ui/stream").onmessage = e => { if (e.data === "changed") refresh(); };
