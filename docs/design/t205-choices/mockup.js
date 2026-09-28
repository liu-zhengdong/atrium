// 设计稿：全景「选项」页签。?v=before 画现在的样子（照抄 app.js 现有写法），默认画新设计（第二版）。
// 截图参数：?dark=1 暗色，?expand=1 展开选项 1 与它的依据，?done=1 展开已拍板的单子，?note=1 打开说明框，?error=1 演示没勾就提交。
import { escapeHtml as esc, linkify } from "../../../server/map/web/format.js";
import { before as beforeChoices, after as afterChoices } from "./sample.js";

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

// ---------------- 新设计（第二版） ----------------

/** 代价档位：small / medium / large → 小 / 中 / 大。 */
const SIZE = { small: "小", medium: "中", large: "大" };

const chevron = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** 出处：短号、谁提的、何时、出自哪个任务，拍板了再加谁哪天拍的。等拍板时悬停标题看，已拍板的展开后看。 */
function origin(c) {
  const by = c.created_by === "a3" ? "产品部（a3）" : c.created_by;
  const decided = c.decided_at
    ? ` · ${decider(c.decided_by)} ${clock(c.decided_at)} 拍板`
    : "";
  return `${c.ref} · ${by} ${clock(c.created_at)} 提 · 出自 ${c.task}${decided}`;
}

/**
 * 一个选项默认只有一行：勾选框、编号、标题（写结果）、推荐、代价「中 · 2 天」、箭头。
 * 展开后三段：能多做到（旧单子把「为什么现在」接在后面）、代价、不做会怎样；依据折成「N 条」。
 * 推荐的选项展开后多一行推荐理由；秘书、leader 倾向它的意见也放这里。
 */
function optionHtml(c, o, open, expanded) {
  const recommended = c.recommend.includes(o.seq);
  const fate =
    o.picked === true
      ? chip(`已选 · ${o.task}`, "green")
      : o.picked === false
        ? chip("没选", "gray")
        : "";
  const size = o.size
    ? chip(`${SIZE[o.size]}${o.days ? ` · ${o.days}` : ""}`, "size")
    : "";
  const tags = `${recommended ? chip("推荐", "purple") : ""}${fate}${size}`;
  const notes = [
    ...(recommended ? [["产品部推荐", c.why]] : []),
    ...c.comments
      .filter((m) => m.prefer?.includes(o.seq))
      .map((m) => [who(m.by), m.text]),
  ]
    .map(
      ([by, text]) =>
        `<p class="option-note"><span>${by}</span>${esc(text)}</p>`,
    )
    .join("");
  const basis = o.basis.length
    ? [
        [
          "依据",
          `<details class="basis-list"${expanded ? " open" : ""}><summary>${o.basis.length} 条</summary><span class="basis-items">${o.basis.map(linkify).join("；")}</span></details>`,
        ],
      ]
    : [];
  const facts = [
    ["能多做到", esc([o.gain, o.why_now].filter(Boolean).join(""))],
    ["代价", esc(o.cost)],
    ["不做会怎样", esc(o.skip)],
    ...basis,
  ]
    .map(
      ([label, html]) =>
        `<div class="option-fact"><dt>${label}</dt><dd>${html}</dd></div>`,
    )
    .join("");
  const pick = open
    ? `<input class="option-pick" type="checkbox" name="pick" value="${o.seq}" aria-label="勾选选项 ${o.seq}：${esc(o.title)}">`
    : "";
  return `<li class="choice-option${open ? " can-pick" : ""}${o.picked === true ? " picked" : ""}">
    ${pick}
    <details class="option-more"${expanded ? " open" : ""}>
      <summary class="option-row">
        <span class="option-seq">${o.seq}</span>
        <span class="option-title">${esc(o.title)}</span>
        <span class="option-tags">${tags}</span>
        <span class="option-toggle" title="看详情">${chevron}</span>
      </summary>
      <div class="option-body">${notes}<dl class="option-facts">${facts}</dl></div>
    </details>
  </li>`;
}

const optionList = (c, open, expandFirst) =>
  `<ol class="choice-options">${c.options.map((o) => optionHtml(c, o, open, expandFirst && o.seq === 1)).join("")}</ol>`;

function openChoice(c) {
  const [label, tone] = CHOICE_STATUS[c.status];
  const noteOpen = params.has("note");
  return `<article class="choice choice-sheet" data-status="open">
    <header class="choice-head" title="${esc(origin(c))}"><h2>${esc(c.title)}</h2><span class="chips">${chip(label, tone)}</span></header>
    <form class="choice-form">
      ${optionList(c, true, params.has("expand"))}
      <div class="choice-actions">
        <button type="submit" value="pick">做勾选的</button>
        <button type="submit" value="pass" class="secondary">这轮都不要</button>
        <button type="button" class="link-button" data-note${noteOpen ? " hidden" : ""}>加一句说明</button>
        <span class="choice-error" role="alert"></span>
      </div>
      <textarea class="choice-note-box" name="note" rows="2" aria-label="说明" placeholder="为什么选这些、为什么不要那些；会记进决定记录，下一轮产品部读得到"${noteOpen ? "" : " hidden"}></textarea>
    </form>
  </article>`;
}

/** 已拍板 / 这轮都不要：整份折成一行，只写选了哪几个、哪天拍的；展开看出处、每个选项和说明。 */
function doneChoice(c) {
  const [label, tone] = CHOICE_STATUS[c.status];
  const picked = c.options.filter((o) => o.picked === true);
  const result =
    c.status === "passed"
      ? "都没选"
      : `选了 ${picked.map((o) => o.seq).join("、")}`;
  return `<details class="choice choice-done" data-status="${c.status}"${params.has("done") ? " open" : ""}>
    <summary title="${esc(origin(c))}">
      <span class="done-title">${esc(c.title)}</span>
      ${chip(label, tone)}
      <span class="done-result">${result} · ${day(c.decided_at)}</span>
    </summary>
    <div class="done-body">
      <p class="choice-meta muted small">${esc(origin(c))}</p>
      ${optionList(c, false, false)}
      ${c.note ? `<p class="option-note"><span>${decider(c.decided_by)}的说明</span>${esc(c.note)}</p>` : ""}
    </div>
  </details>`;
}

// ---------------- 页面骨架（照全景组织根页） ----------------

const TABS = ["组成部分", "选项", "负责人", "专员", "技能", "执行者", "原则"];

function page() {
  const before = params.get("v") === "before";
  const choices = before ? beforeChoices : afterChoices;
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
      <div role="tabpanel"><div class="choices${before ? "" : " v2"}">${list}</div></div>
    </section>`;
}

async function styles() {
  // 暗色截图：把「跟随系统暗色」的媒体查询改成总是生效。
  const dark = params.has("dark");
  const sheets = ["../../../server/map/web/style.css"];
  if (params.get("v") !== "before") sheets.push("./choices.css");
  for (const url of sheets) {
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
  const note = event.target.closest("[data-note]");
  if (!note) return;
  const box = note.closest("form").querySelector(".choice-note-box");
  note.hidden = true;
  box.hidden = false;
  box.focus();
});
document.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  const error = form.querySelector(".choice-error");
  const picks = form.querySelectorAll("input[name=pick]:checked");
  error.textContent =
    event.submitter?.value === "pick" && !picks.length
      ? "先勾选要做的；都不要就点「这轮都不要」。"
      : "（设计稿：这里会拍板）";
});
if (params.has("error")) document.querySelector("button[value=pick]")?.click();
// 默认状态下 .choices 里看得到的字数（不算空白），README 的字数对照用它量。
document.body.dataset.chars = Array.from(
  document.querySelector(".choices").innerText.replace(/\s/g, ""),
).length;
