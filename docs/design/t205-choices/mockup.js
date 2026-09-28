// 设计稿：全景「选项」页签。?v=before 画现在的样子（照抄 app.js 现有写法），默认画新设计。
// 截图参数：?dark=1 暗色，?expand=1 展开选项 1 与它的依据，?done=1 展开已拍板的单子，?error=1 演示没勾就提交。
import { escapeHtml as esc, linkify } from "../../../server/map/web/format.js";
import { choices } from "./sample.js";

const params = new URLSearchParams(location.search);

const chip = (text, tone) =>
  `<span class="chip chip-${tone}">${esc(text)}</span>`;
const who = (by) =>
  by === "secretary" ? "秘书" : by === "a3" ? "产品部（a3）" : esc(by);
const clock = (at) => {
  const d = new Date(at);
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
const day = (at) => clock(at).slice(0, 5);
const decider = (by) => (!by || by === "u1" ? "你" : esc(by));
const CHOICE_STATUS = {
  open: ["等你拍板", "amber"],
  picked: ["已拍板", "blue"],
  passed: ["这轮都不要", "gray"],
};

// ---------------- 现在的样子（照抄 app.js，用来对比） ----------------

const OPTION_FACTS = [
  ["gain", "能多做到"],
  ["why_now", "为什么现在"],
  ["cost", "代价"],
  ["skip", "不做会怎样"],
];

function beforeOption(c, o, open) {
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
    ${open ? `<label class="option-head"><input type="checkbox" name="pick" value="${o.seq}">${head}</label>` : `<div class="option-head">${head}</div>`}
    <dl class="option-facts">${facts}${basis}</dl>
  </li>`;
}

function beforeChoice(c) {
  const [label, tone] = CHOICE_STATUS[c.status];
  const open = c.status === "open";
  const options = `<ol class="choice-options">${c.options.map((o) => beforeOption(c, o, open)).join("")}</ol>`;
  const recommend = `<p class="choice-recommend"><span class="choice-label">产品部推荐</span>选项 ${c.recommend.join("、")}——${esc(c.why)}</p>`;
  const body = open
    ? `<form class="choice-form">${options}${recommend}
        <label class="choice-note"><span class="choice-label">说明（可不写）</span><textarea rows="2"></textarea></label>
        <div class="choice-actions"><button type="button">做勾选的</button><button type="button" class="secondary">这轮都不要</button></div>
      </form>`
    : `${options}${recommend}`;
  return `<article class="choice" data-status="${c.status}">
    <header class="choice-head"><span class="task-ref">${c.ref}</span><h2>${esc(c.title)}</h2><span class="chips">${chip(label, tone)}</span></header>
    <p class="choice-meta muted small">${who(c.created_by)}提于 ${clock(c.created_at)} · 出自 ${c.task}</p>
    ${body}
  </article>`;
}

// ---------------- 新设计 ----------------

/** 代价档位：small / medium / large → 小 / 中 / 大。 */
const SIZE = { small: "小", medium: "中", large: "大" };
const ONE_LINE = 40;

/** 一句话：有 summary 用 summary；旧单子退回「能多做到」的第一句，超过 40 字截断。 */
function oneLine(o) {
  if (o.summary) return o.summary;
  const first = o.gain.split(/(?<=[。！？])/)[0].replace(/[。！？]$/, "");
  const chars = Array.from(first);
  return chars.length <= ONE_LINE
    ? first
    : `${chars.slice(0, ONE_LINE - 1).join("")}…`;
}

/** 推荐理由拆成第一句（放顶上）和其余（点开看）。 */
function splitWhy(why) {
  const [first, ...rest] = why.split(/(?<=[。！？])/);
  return { first: first.replace(/[。！？]$/, ""), rest: rest.join("") };
}

const chevron = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function optionHtml(c, o, open, expanded) {
  const recommended = c.recommend.includes(o.seq);
  const fate =
    o.picked === true
      ? chip(`已选 · ${o.task}`, "green")
      : o.picked === false
        ? chip(`没选 · 记为 ${o.decision}`, "gray")
        : "";
  const size = o.size
    ? `<span class="chip chip-size"><b>${SIZE[o.size]}</b>${o.effort ? ` · ${esc(o.effort)}` : ""}</span>`
    : "";
  const tags = `${recommended ? chip("推荐", "purple") : ""}${fate}${size}`;
  const facts = [
    ...(o.summary ? [["gain", "能多做到"]] : []),
    ["why_now", "为什么现在"],
    ["cost", "代价"],
    ["skip", "不做会怎样"],
  ]
    .map(
      ([key, label]) =>
        `<div class="option-fact"><dt>${label}</dt><dd>${esc(o[key])}</dd></div>`,
    )
    .join("");
  const basis = o.basis.length
    ? `<div class="option-fact"><dt>依据</dt><dd><details class="basis-list"${expanded ? " open" : ""}><summary>${o.basis.length} 条</summary><span class="basis-items">${o.basis.map(linkify).join("；")}</span></details></dd></div>`
    : "";
  const pick = open
    ? `<input class="option-pick" type="checkbox" name="pick" value="${o.seq}" aria-label="勾选选项 ${o.seq}：${esc(o.title)}">`
    : "";
  return `<li class="choice-option${open ? " can-pick" : ""}${o.picked === true ? " picked" : ""}">
    ${pick}
    <details class="option-more"${expanded ? " open" : ""}>
      <summary class="option-row">
        <span class="option-main">
          <span class="option-line"><span class="option-seq">${o.seq}</span><span class="option-title">${esc(o.title)}</span></span>
          <span class="option-summary">${esc(oneLine(o))}</span>
        </span>
        <span class="option-tags">${tags}</span>
        <span class="option-toggle" title="看详情">${chevron}</span>
      </summary>
      <dl class="option-facts">${facts}${basis}</dl>
    </details>
  </li>`;
}

function adviceHtml(c, open) {
  const { first, rest } = splitWhy(c.why);
  const more = rest
    ? `<details class="advice-more"><summary>理由全文</summary><p>${esc(c.why)}</p></details>`
    : "";
  const follow = open
    ? `<button type="button" class="link-button" data-follow="${c.recommend.join(",")}">照推荐勾选</button>`
    : "";
  const comments = c.comments.length
    ? `<div class="choice-comments"><span class="choice-label">意见</span>${c.comments
        .map(
          (m) =>
            `<strong>${who(m.by)}</strong>：${esc(m.text)}${m.prefer?.length ? `（倾向选项 ${m.prefer.join("、")}）` : ""}`,
        )
        .join("；")}</div>`
    : "";
  return `<div class="choice-advice">
      <span class="choice-label">产品部推荐</span>
      <span class="advice-body"><span class="advice-pick">选 ${c.recommend.join("、")}</span>——${esc(first)}${more}</span>
      ${follow}
    </div>${comments}`;
}

function listHtml(c, open, expandFirst) {
  return `<div class="list-tools"><span>${c.options.length} 个选项，点一行看详情</span><button type="button" class="link-button" data-expand-all>全部展开</button></div>
    <ol class="choice-options">${c.options.map((o) => optionHtml(c, o, open, expandFirst && o.seq === 1)).join("")}</ol>`;
}

function openChoice(c) {
  const [label, tone] = CHOICE_STATUS[c.status];
  return `<article class="choice choice-sheet" data-status="open">
    <header class="choice-head"><span class="task-ref">${c.ref}</span><h2>${esc(c.title)}</h2><span class="chips">${chip(label, tone)}</span></header>
    <p class="choice-meta muted small">${who(c.created_by)}提于 ${clock(c.created_at)} · 出自 ${c.task}</p>
    ${adviceHtml(c, true)}
    <form class="choice-form">
      ${listHtml(c, true, params.has("expand"))}
      <label class="choice-note"><span class="choice-label">说明（可不写）</span>
        <textarea name="note" rows="2" placeholder="为什么选这些、为什么不要那些；没选的会连同这句记进决定记录，下一轮产品部读得到"></textarea>
      </label>
      <div class="choice-actions">
        <button type="submit" value="pick">做勾选的</button>
        <button type="submit" value="pass" class="secondary">这轮都不要</button>
        <span class="choice-error" role="alert"></span>
      </div>
    </form>
  </article>`;
}

/** 已拍板 / 这轮都不要：整份折成一行，写清选了哪几个、落成了哪些任务。 */
function doneChoice(c) {
  const [label, tone] = CHOICE_STATUS[c.status];
  const picked = c.options.filter((o) => o.picked === true);
  const skipped = c.options.filter((o) => o.picked === false);
  const result =
    c.status === "passed"
      ? `${c.options.length} 个都没选`
      : `选了 ${picked.map((o) => `${o.seq}（${o.task}）`).join("、")}${skipped.length ? `；没选 ${skipped.map((o) => o.seq).join("、")}` : ""}`;
  return `<details class="choice choice-done" data-status="${c.status}"${params.has("done") ? " open" : ""}>
    <summary>
      <span class="task-ref">${c.ref}</span>
      <span class="done-title">${esc(c.title)}</span>
      ${chip(label, tone)}
      <span class="done-result">${result} · ${decider(c.decided_by)} ${day(c.decided_at)} 拍板</span>
    </summary>
    <div class="done-body">
      <p class="choice-meta muted small">${who(c.created_by)}提于 ${clock(c.created_at)} · 出自 ${c.task} · ${decider(c.decided_by)}拍板于 ${clock(c.decided_at)}</p>
      ${adviceHtml(c, false)}
      ${listHtml(c, false, false)}
      ${c.note ? `<p class="choice-recommend"><span class="choice-label">${decider(c.decided_by)}的说明</span>${esc(c.note)}</p>` : ""}
    </div>
  </details>`;
}

// ---------------- 页面骨架（照全景组织根页） ----------------

const TABS = ["组成部分", "选项", "负责人", "专员", "技能", "执行者", "原则"];

function page() {
  const before = params.get("v") === "before";
  const list = before
    ? choices.map(beforeChoice).join("")
    : choices
        .map((c) => (c.status === "open" ? openChoice(c) : doneChoice(c)))
        .join("");
  return `<header class="intro">
      <span class="kind">组织</span>
      <h1>你的 AI 组织</h1>
      <p>你的 AI 组织现在管两件事：Atrium，让一群 AI 替你把活干完；OpenQuota，看清各家订阅还剩多少额度，好知道该派给谁。</p>
    </header>
    <section class="view">
      <div class="tabbar"><div class="tabs" role="tablist" aria-label="视图">${TABS.map(
        (t) =>
          `<a class="tab" role="tab" href="#" aria-selected="${t === "选项"}"><span>${t}</span>${t === "选项" ? `<span class="badge">${choices.length}</span>` : ""}</a>`,
      ).join("")}</div></div>
      <div role="tabpanel"><div class="choices">${list}</div></div>
    </section>`;
}

async function styles() {
  // 暗色截图：把「跟随系统暗色」的媒体查询改成总是生效。
  const dark = params.has("dark");
  for (const url of ["../../../server/map/web/style.css", "./choices.css"]) {
    let css = await (await fetch(url)).text();
    if (dark)
      css =
        css.replaceAll("@media (prefers-color-scheme: dark)", "@media all") +
        ":root { color-scheme: dark; }";
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
  }
}

await styles();
document.getElementById("page").innerHTML = page();

document.addEventListener("click", (event) => {
  const follow = event.target.closest("[data-follow]");
  if (follow) {
    const seqs = follow.dataset.follow.split(",");
    const form = follow.closest("article").querySelector("form");
    for (const input of form.querySelectorAll("input[name=pick]"))
      input.checked = seqs.includes(input.value);
  }
  const all = event.target.closest("[data-expand-all]");
  if (all) {
    const list = all.parentElement.nextElementSibling;
    const opening = all.textContent === "全部展开";
    for (const d of list.querySelectorAll("details.option-more"))
      d.open = opening;
    all.textContent = opening ? "全部收起" : "全部展开";
  }
});
document.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  const error = form.querySelector(".choice-error");
  const picks = form.querySelectorAll("input[name=pick]:checked");
  error.textContent =
    event.submitter?.value === "pick" && !picks.length
      ? "先勾选要做的选项；都不要就点「这轮都不要」。"
      : "（设计稿：这里会拍板）";
});
if (params.has("error")) document.querySelector("button[value=pick]")?.click();
