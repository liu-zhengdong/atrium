// 任务视图原型（t120）：假数据，只读。节点「任务」页签分成三组——在做 / 接下来 / 做完了。
// 地址：#o1 组织根、#o4 部分、#r2 专员、#w/claude+opus:high 执行者；
// 后缀 /before 看现状（同一份数据的「全部」表），/empty 空态，/more 做完了多看 20 条，/find=文字 搜索。
// 渲染助手（esc、linkify）与线上全景同一份。

import { escapeHtml as esc, linkify } from "../../../server/map/web/format.js";

const $ = (id) => document.getElementById(id);
/** 固定「现在」：截图可复现。2026-09-27 15:40。 */
const NOW = new Date(2026, 8, 27, 15, 40).getTime();
const MIN = 60000;
const ago = (m) => NOW - m * MIN;
const at = (d, h, m) => new Date(2026, 8, d, h, m).getTime();

// ---- 假数据：组织、专员、负责人、执行者 ----

const NODES = {
  o1: { name: "你的 AI 组织", kind: "org", parent: null },
  o2: { name: "Atrium", kind: "project", parent: "o1" },
  o3: { name: "OpenQuota", kind: "project", parent: "o1" },
  o4: { name: "命令行和网页", kind: "module", parent: "o2" },
  o5: { name: "任务账本", kind: "module", parent: "o2" },
  o6: { name: "执行者", kind: "module", parent: "o2" },
  o7: { name: "验收关卡", kind: "module", parent: "o2" },
};
const WHAT = {
  o1: "你的 AI 组织现在管两件事：Atrium，让一群 AI 替你把活干完；OpenQuota，看清各家订阅还剩多少额度，好知道该派给谁。",
  o4: "你和 Agent 都从这里用 Atrium：atrium 命令、全景网页、atrium top 和状态栏。",
};
const ROLES = { r1: "后端", r2: "前端", r3: "审查", r4: "文档" };
const LEADERS = { a1: "Atrium 负责人", a2: "OpenQuota 负责人" };
const W = {
  opus: "claude+opus:high",
  codex: "codex+gpt-6-sol:high",
  kimi: "kimi+kimi-k3",
  glm: "opencode+opencode/glm-5",
};

/** 执行者标识 claude+opus:high → Claude · Opus · high（与线上 workerLabel 同规则）。 */
function workerLabel(id) {
  const [tool, rest = ""] = id.split("+");
  const [model, effort] = rest.split(":");
  let m = model.slice(model.lastIndexOf("/") + 1);
  if (tool === "claude") m = m[0].toUpperCase() + m.slice(1);
  return [tool === "claude" ? "Claude" : tool, m, effort]
    .filter(Boolean)
    .join(" · ");
}

// 每个任务：公共字段 + 所在组（now / next / done）的字段。
const TASKS = [
  // ---- 在做：等你 → 卡住 → 执行者在做 → 合入流水线 ----
  {
    ref: "t115",
    title: "OpenQuota 支持 Gemini 订阅",
    part: "o3",
    job: "r1",
    by: "a2",
    started: ago(200),
    now: {
      kind: "user",
      text: "会审上交：要不要读浏览器里的 Google 登录信息",
    },
  },
  {
    ref: "t116",
    title: "合入队列冲突时附上冲突文件列表",
    part: "o7",
    job: "r1",
    by: "a1",
    worker: W.codex,
    started: ago(95),
    now: {
      kind: "blocked",
      holder: { leader: "a1" },
      text: "本地检查没过：merge-runtime 3 个用例超时",
    },
  },
  {
    ref: "t120",
    title: "全景任务视图设计稿：在做 / 接下来 / 做完了 分开看",
    part: "o4",
    job: "r2",
    by: "secretary",
    worker: W.opus,
    started: ago(48),
    now: { kind: "worker", text: "渲染亮暗、宽窄四张截图" },
  },
  {
    ref: "t121",
    title: "统一 top 与状态栏的状态叫法",
    part: "o4",
    job: "r1",
    worker: W.codex,
    started: ago(23),
    now: { kind: "worker", text: "改 cli/top.ts 表头：「在跑」改成「在做」" },
  },
  {
    ref: "t118",
    title: "额度读取器补 kimi 与 grok",
    part: "o6",
    job: "r1",
    by: "a1",
    worker: W.kimi,
    started: ago(72),
    now: {
      kind: "worker",
      text: "跑 npm test：quota-readers 12/14 通过",
      note: { by: "Atrium 负责人", text: "grok 没有用量接口就先跳过，别卡住" },
    },
  },
  {
    ref: "t114",
    title: "task wait 支持同时等多个任务",
    part: "o4",
    job: "r1",
    worker: W.codex,
    started: ago(130),
    now: { kind: "merge", stage: "合入中", text: "rebase 并重跑本地检查" },
  },
  {
    ref: "t112",
    title: "横跨部分第 2 步：全景网页显示牵涉",
    part: "o4",
    job: "r2",
    by: "a1",
    worker: W.opus,
    started: ago(160),
    now: { kind: "merge", stage: "排队合入", text: "前面还有 1 个" },
  },
  {
    ref: "t108",
    title: "横跨部分第 1 步：管方面的部分、牵涉、专员归属",
    part: "o5",
    job: "r1",
    worker: W.opus,
    started: ago(260),
    pr: 376,
    now: { kind: "merge", stage: "已合入", text: "等发版上线" },
  },

  // ---- 接下来：紧急 → 排队 → 就绪 → 等待中 → 卡住 ----
  {
    ref: "t123",
    title: "修复 restart 后在跑执行者没被接管",
    part: "o2",
    job: "r1",
    urgent: true,
    worker: W.codex,
    created: ago(6),
    next: { kind: "queued", text: "等执行者：codex 同时只能做 2 件，已满" },
  },
  {
    ref: "t119",
    title: "OpenQuota 读取 Copilot 用量",
    part: "o3",
    job: "r1",
    by: "a2",
    worker: W.opus,
    created: ago(55),
    next: {
      kind: "queued",
      text: "等额度：Claude 5 小时窗口用完，16:10 恢复",
    },
  },
  {
    ref: "t122",
    title: "全景网页加「角色、技能、执行者」三个页签",
    part: "o4",
    job: "r2",
    by: "secretary",
    created: ago(140),
    next: { kind: "ready", text: "自动派，下一个就是它" },
  },
  {
    ref: "t124",
    title: "README 同步 task plan 的新输出",
    part: "o4",
    job: "r4",
    created: ago(300),
    next: { kind: "ready", text: "手动派：等秘书决定什么时候派" },
  },
  {
    ref: "t125",
    title: "全景任务视图：实现在做 / 接下来 / 做完了",
    part: "o4",
    job: "r2",
    by: "secretary",
    created: ago(40),
    next: {
      kind: "waiting",
      wait: [{ ref: "t120", text: "在做（Claude · Opus · 48 分钟）" }],
    },
  },
  {
    ref: "t126",
    title: "update 前先确认合入队列已清空",
    part: "o5",
    job: "r1",
    by: "a1",
    created: ago(90),
    next: {
      kind: "waiting",
      wait: [
        { ref: "t114", text: "的 PR #380 合入" },
        { ref: "t108", text: "上线" },
      ],
    },
  },
  {
    ref: "t127",
    title: "grok 适配器接上额度信号",
    part: "o6",
    job: "r1",
    by: "a1",
    created: ago(380),
    next: {
      kind: "blocked",
      wait: [{ ref: "t117", text: "失败了" }],
      tail: "，Atrium 负责人在处理",
    },
  },

  // ---- 做完了：按结束时间倒序 ----
  {
    ref: "t113",
    title: "紧急任务跳过本机负载限制；本机负载改看 Atrium 自己的进程树",
    part: "o6",
    job: "r1",
    urgent: true,
    worker: W.opus,
    started: at(27, 9, 20),
    ended: at(27, 11, 2),
    done: { result: "online", version: "0.1.93", pr: 374, story: "一次通过" },
  },
  {
    ref: "t117",
    title: "grok 适配器支持 thinking 参数",
    part: "o6",
    job: "r1",
    by: "a1",
    worker: W.kimi,
    started: at(27, 8, 5),
    ended: at(27, 10, 41),
    done: {
      result: "failed",
      reason: "思考耗尽，换了两个执行者仍没做完",
    },
  },
  {
    ref: "t111",
    title: "修复全景网页专员接口会话鉴权",
    part: "o4",
    job: "r1",
    worker: W.codex,
    started: at(27, 7, 50),
    ended: at(27, 8, 25),
    done: {
      result: "online",
      version: "0.1.92",
      pr: 372,
      story: "本地检查没过 1 次，交回后通过",
    },
  },
  {
    ref: "t109",
    title: "合并「角色」与「专员」两个说法",
    part: "o4",
    job: "r4",
    by: "secretary",
    started: null,
    ended: at(27, 7, 12),
    done: { result: "cancelled", reason: "秘书并进 t104 一起做" },
  },
  {
    ref: "t104",
    title: "合并角色与专员并撤销安全、质量示例节点",
    part: "o2",
    job: "r1",
    worker: W.opus,
    started: at(26, 18, 10),
    ended: at(26, 21, 30),
    done: {
      result: "online",
      version: "0.1.91",
      pr: 359,
      story: "审阅打回 1 次后通过",
    },
  },
  {
    ref: "t107",
    title: "测试子进程固定关掉颜色，修 statusline 用例在 CI 挂",
    part: "o4",
    job: "r1",
    worker: W.codex,
    started: at(26, 16, 2),
    ended: at(26, 16, 20),
    done: { result: "online", version: "0.1.91", pr: 371, story: "一次通过" },
  },
  {
    ref: "t105",
    title: "OpenQuota 首页加「下次恢复时间」",
    part: "o3",
    job: "r2",
    by: "a2",
    worker: W.glm,
    started: at(26, 13, 40),
    ended: at(26, 15, 5),
    done: { result: "merged", pr: 41, story: "一次通过" },
  },
  {
    ref: "t103",
    title: "调研：Gemini 订阅有没有用量接口",
    part: "o3",
    job: null,
    by: "a2",
    worker: W.opus,
    started: at(26, 10, 0),
    ended: at(26, 10, 38),
    done: { result: "done", story: "结论写进任务结果：没有公开接口" },
  },
  {
    ref: "t106",
    title: "workers ls / show 时间改用本地时区",
    part: "o4",
    job: "r1",
    worker: W.codex,
    started: at(25, 21, 10),
    ended: at(25, 21, 42),
    done: { result: "online", version: "0.1.90", pr: 370, story: "一次通过" },
  },
  {
    ref: "t102",
    title: "本机减负：执行者并发上限、负载闸门、测试并发注入",
    part: "o6",
    job: "r1",
    worker: W.opus,
    started: at(25, 14, 0),
    ended: at(25, 17, 45),
    done: {
      result: "online",
      version: "0.1.89",
      pr: 366,
      story: "合入时冲突 1 次，交回后通过",
    },
  },
  {
    ref: "t101",
    title: "全景与 map 体验小修：帮助讲裸命令、子部分在跑数",
    part: "o4",
    job: "r2",
    worker: W.kimi,
    started: at(25, 9, 30),
    ended: at(25, 12, 10),
    done: {
      result: "failed",
      reason: "本地检查超时 3 次，转卡住后秘书改派 t99",
    },
  },
];
const DONE_TOTAL = 96;

/** 「再看 20 条」加载的更早记录：轮流取几种结果，只为撑出长度。 */
function olderDone(count) {
  const kinds = ["online", "online", "merged", "online", "failed", "cancelled"];
  const titles = [
    "task pick：专员第 1 选超速时改推荐更富余的候选",
    "秘书与 leader 的备忘和决定记录进 Atrium",
    "修复自升级时旧服务关闭卡住",
    "执行者档案进库并留修订",
    "全景看得到负责人：节点页负责人一行、负责人页",
    "额度自带读取第 1 步：claude、codex、opencode",
    "派活候选一览 task pick",
    "实现手动体验巡检与发现交 leader",
    "全景网页任务行显示任务编号 tN",
    "上线结论直投秘书并补记历史已上线任务",
  ];
  return Array.from({ length: count }, (_, i) => {
    const result = kinds[i % kinds.length];
    const day = 24 - Math.floor(i / 5);
    const ended = at(day, 20 - (i % 5) * 3, 10 + i);
    return {
      ref: `t${99 - i}`,
      title: titles[i % titles.length],
      part: ["o4", "o5", "o6", "o3"][i % 4],
      job: ["r1", "r2", "r1", "r4"][i % 4],
      worker: [W.opus, W.codex, W.kimi][i % 3],
      started: ended - (30 + i * 7) * MIN,
      ended,
      done:
        result === "failed"
          ? { result, reason: "CI 没过：quota 用例依赖本机主目录" }
          : result === "cancelled"
            ? { result, reason: "需求改了，秘书取消" }
            : {
                result,
                version: result === "online" ? `0.1.${87 - (i % 6)}` : null,
                pr: 360 - i,
                story: i % 3 ? "一次通过" : "本地检查没过 1 次，交回后通过",
              },
    };
  });
}

// ---- 人话 ----

function duration(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 1) return "不到 1 分钟";
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}
const pad2 = (n) => String(n).padStart(2, "0");
const clock = (t) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
function dayLabel(t) {
  const d = new Date(t);
  const today = new Date(NOW);
  const diff = Math.round(
    (new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000,
  );
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const chip = (text, tone) =>
  `<span class="chip chip-${tone}">${esc(text)}</span>`;
const chipLink = (text, tone, url) =>
  `<a class="chip chip-${tone} chip-link" href="${esc(url)}">${esc(text)}</a>`;
const none = `<span class="muted">—</span>`;
const cell = (label, body, extra = "") =>
  `<span class="cell${extra}" role="cell" data-label="${esc(label)}">${body}</span>`;
const taskLink = (ref) => `<a class="ref-link" href="#find=${ref}">${ref}</a>`;
const workerHref = (id) => `#w/${id}`;

/** 任务名：编号、标题；下一行是归属部分（不是本页那块时）与谁派的。 */
function taskName(t, ctx, kind) {
  const meta = [
    ctx.page !== "node" || t.part !== ctx.ref
      ? `<span>${esc(NODES[t.part].name)}</span>`
      : "",
    t.by
      ? `<span class="by">${esc(t.by === "secretary" ? "秘书" : LEADERS[t.by])}派的</span>`
      : "",
  ].filter(Boolean);
  return `<span class="task-ref">${esc(t.ref)}</span><span class="task-title">${t.urgent && kind !== "done" ? `<span class="urgent">紧急</span>` : ""}${esc(t.title)}${meta.length ? `<span class="task-meta">${meta.join(`<span class="dot-sep">·</span>`)}</span>` : ""}</span>`;
}

// ---- 三组 ----

/** 在做一组里的顺序与叫法：与状态栏一致——等你、卡住（谁在处理）、在做、合入流水线。 */
const NOW_ORDER = ["user", "blocked", "worker", "merge"];
const MERGE_ORDER = ["审阅中", "排队合入", "合入中", "已合入"];
function nowChip(t) {
  const k = t.now.kind;
  if (k === "user") return chip("等你", "red strong");
  if (k === "blocked") return chip("卡住", "orange");
  if (k === "worker") return chip("在做", "green");
  return chip(t.now.stage, "blue");
}
function holderCell(t) {
  const k = t.now.kind;
  if (k === "user") return chip("你", "red");
  if (k === "blocked") {
    const h = t.now.holder;
    return h.leader
      ? chipLink(LEADERS[h.leader], "leader", `#a${h.leader.slice(1)}`)
      : chipLink("秘书", "leader", "#secretary");
  }
  if (k === "worker")
    return `<a class="chip chip-soft clip chip-link" href="${esc(workerHref(t.worker))}">${esc(workerLabel(t.worker))}</a>`;
  return `<span class="runtime">合入队列</span>`;
}

const NEXT_ORDER = ["queued", "ready", "waiting", "blocked"];
const NEXT_TAG = {
  queued: ["排队", "gray"],
  ready: ["就绪", "gray"],
  waiting: ["等待中", "gray"],
  blocked: ["卡住", "orange"],
};
function waitCell(t) {
  const n = t.next;
  if (n.wait)
    return `${n.kind === "blocked" ? "上游 " : "等 "}${n.wait
      .map((w) => `${taskLink(w.ref)} ${esc(w.text)}`)
      .join("、")}${esc(n.tail ?? "")}`;
  return esc(n.text);
}

const RESULT = {
  online: (d) => [`已上线 v${d.version}`, "gray"],
  merged: () => ["已合入", "gray"],
  done: () => ["完成", "gray"],
  failed: () => ["失败", "red"],
  cancelled: () => ["取消", "gray"],
};

const COLS = {
  now: ["任务", "专员", "状态", "谁在处理", "用时", "最近动作"],
  next: ["任务", "专员", "状态", "谁来做", "已等", "在等什么"],
  done: ["任务", "专员", "结果", "谁做的", "用时", "经过"],
};

/** 一组的表：ctx.page 是 role 时不列专员，是 worker 时不列「谁」那一列。 */
function groupTable(kind, rows, ctx, empty) {
  const skip = (i) =>
    (ctx.page === "role" && i === 1) || (ctx.page === "worker" && i === 3);
  const heads = COLS[kind].filter((_, i) => !skip(i));
  const variant =
    ctx.page === "role" ? "no-role" : ctx.page === "worker" ? "no-who" : "full";
  const body = rows.length
    ? rows.map((r) => (r.day ? dayRow(r) : rowOf(kind, r, ctx, skip))).join("")
    : `<p class="empty">${empty}</p>`;
  return `<div class="table table-tg tg-${variant}" role="table">
    ${rows.length ? `<div class="row head" role="row">${heads.map((h) => `<span role="columnheader">${esc(h)}</span>`).join("")}</div>` : ""}
    ${body}
  </div>`;
}
const dayRow = (r) =>
  `<div class="day-row" role="row"><span role="cell">${esc(r.day)}</span></div>`;

function rowOf(kind, t, ctx, skip) {
  const cells = [];
  cells.push(cell("任务", taskName(t, ctx, kind), " name plain task"));
  cells.push(
    t.job
      ? cell("专员", chipLink(ROLES[t.job], "role", `#${t.job}`))
      : cell("专员", none, " none"),
  );
  if (kind === "now") {
    const took = duration(NOW - t.started);
    const note = t.now.note
      ? `<span class="clamp note-line"><span class="note-by">${esc(t.now.note.by)}：</span>${esc(t.now.note.text)}</span>`
      : "";
    cells.push(cell("状态", nowChip(t)));
    // 等你：状态已写「等你」，窄屏不再重复「你」。
    cells.push(
      cell("谁在处理", holderCell(t), t.now.kind === "user" ? " none" : ""),
    );
    cells.push(cell("用时", took, " muted tagged"));
    cells.push(
      cell(
        "最近动作",
        `<span class="clamp">${linkify(t.now.text)}</span>${note}`,
        t.now.kind === "user" ? " note wait-you" : " note",
      ),
    );
  } else if (kind === "next") {
    const [label, tone] = NEXT_TAG[t.next.kind];
    cells.push(cell("状态", chip(label, tone)));
    cells.push(
      t.worker
        ? cell(
            "谁来做",
            `<a class="chip chip-soft clip chip-link" href="${esc(workerHref(t.worker))}">${esc(workerLabel(t.worker))}</a>`,
          )
        : cell("谁来做", none, " none"),
    );
    cells.push(cell("已等", duration(NOW - t.created), " muted tagged"));
    cells.push(cell("在等什么", waitCell(t), " note"));
  } else {
    const d = t.done;
    const [label, tone] = RESULT[d.result](d);
    const pr = d.pr
      ? `<a class="pr" href="#" title="在 GitHub 打开">PR #${d.pr}</a>`
      : "";
    const story = d.reason ?? d.story ?? "";
    cells.push(cell("结果", chip(label, tone)));
    cells.push(
      t.worker
        ? cell(
            "谁做的",
            `<a class="chip chip-soft clip chip-link" href="${esc(workerHref(t.worker))}">${esc(workerLabel(t.worker))}</a>`,
          )
        : cell("谁做的", none, " none"),
    );
    cells.push(
      t.started
        ? cell("用时", duration(t.ended - t.started), " muted tagged")
        : cell("用时", "—", " muted none"),
    );
    cells.push(
      cell(
        "经过",
        `${pr}${pr && story ? `<span class="dot-sep">·</span>` : ""}${esc(story)}`,
        d.result === "failed" ? " note failed" : " note",
      ),
    );
  }
  const kept = cells.filter((_, i) => !skip(i));
  const gone = kind === "done" && t.done.result === "cancelled" ? " gone" : "";
  const title =
    kind === "done"
      ? ` title="${esc(`${dayLabel(t.ended)} ${clock(t.ended)} 结束`)}"`
      : "";
  return `<div class="row${gone}" role="row"${title}>${kept.join("")}</div>`;
}

/** 做完了：按结束时间倒序，按天插一行小标题。 */
function withDays(list) {
  const out = [];
  let last = "";
  for (const t of list) {
    const d = dayLabel(t.ended);
    if (d !== last) {
      const n = list.filter((x) => dayLabel(x.ended) === d).length;
      out.push({ day: `${d} · ${n} 件` });
      last = d;
    }
    out.push(t);
  }
  return out;
}

function summary(parts) {
  const text = parts
    .filter(([, n]) => n)
    .map(([label, n]) => `${label} ${n}`)
    .join(" · ");
  return text ? `<span class="group-sum">${esc(text)}</span>` : "";
}

function groups(list, ctx) {
  const now = list
    .filter((t) => t.now)
    .sort(
      (a, b) =>
        NOW_ORDER.indexOf(a.now.kind) - NOW_ORDER.indexOf(b.now.kind) ||
        MERGE_ORDER.indexOf(a.now.stage) - MERGE_ORDER.indexOf(b.now.stage) ||
        a.started - b.started,
    );
  const next = list
    .filter((t) => t.next)
    .sort(
      (a, b) =>
        (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) ||
        NEXT_ORDER.indexOf(a.next.kind) - NEXT_ORDER.indexOf(b.next.kind) ||
        a.created - b.created,
    );
  const doneAll = list.filter((t) => t.done).sort((a, b) => b.ended - a.ended);
  const shown = ctx.more ? 30 : 10;
  const done = doneAll.slice(0, shown);
  const total = ctx.empty
    ? 0
    : ctx.find
      ? doneAll.length
      : ctx.page === "node" && ctx.ref === "o1"
        ? DONE_TOTAL
        : doneAll.length;
  const count = (arr, pred) => arr.filter(pred).length;
  const nowSum = summary([
    // 与状态栏头一行同样的叫法和顺序。
    ["等你", count(now, (t) => t.now.kind === "user")],
    ["在做", count(now, (t) => t.now.kind === "worker")],
    [
      "负责人处理",
      count(now, (t) => t.now.kind === "blocked" && t.now.holder.leader),
    ],
    [
      "秘书处理",
      count(now, (t) => t.now.kind === "blocked" && !t.now.holder.leader),
    ],
    ["合入", count(now, (t) => t.now.kind === "merge")],
  ]);
  const nextSum = summary([
    ["排队", count(next, (t) => t.next.kind === "queued")],
    ["就绪", count(next, (t) => t.next.kind === "ready")],
    ["等待中", count(next, (t) => t.next.kind === "waiting")],
    ["卡住", count(next, (t) => t.next.kind === "blocked")],
  ]);
  const findEmpty = ctx.find ? "没有匹配的任务。" : null;
  const sections = [
    `<section class="group" aria-label="在做">
      <h2 class="group-head">在做<span class="badge">${now.length}</span>${nowSum}</h2>
      ${groupTable("now", now, ctx, findEmpty ?? "现在没人在做。")}
    </section>`,
  ];
  // 执行者页：接下来的活挑到人才知道是谁，空着就不画这一组。
  if (!(ctx.page === "worker" && !next.length))
    sections.push(`<section class="group" aria-label="接下来">
      <h2 class="group-head">接下来<span class="badge">${next.length}</span>${nextSum}</h2>
      ${groupTable("next", next, ctx, findEmpty ?? "没有排着的任务。")}
    </section>`);
  const moreLeft = Math.min(20, total - done.length);
  const more =
    doneAll.length > done.length || (total > done.length && !ctx.find)
      ? `<div class="more-bar"><a class="filter more" href="${esc(`#${ctx.key}/more`)}">再看 ${moreLeft} 条</a><span class="muted">共 ${total} 件，已显示 ${done.length} 件</span></div>`
      : "";
  sections.push(`<section class="group" aria-label="做完了">
      <h2 class="group-head">做完了<span class="badge">${total}</span></h2>
      ${groupTable("done", withDays(done), ctx, findEmpty ?? "还没有做完的任务。")}
      ${more}
    </section>`);
  return sections.join("");
}

// ---- 现状（对照）：同一份数据，线上「全部」筛选的一张表 ----

function beforeTable(list) {
  const tag = (t) =>
    t.now
      ? t.now.kind === "blocked"
        ? ["卡住", "orange"]
        : t.now.kind === "merge"
          ? t.now.stage === "已合入"
            ? ["已合入", "gray"]
            : ["等合入", "blue"]
          : t.now.kind === "user"
            ? ["卡住", "orange"]
            : ["进行中", "green"]
      : t.next
        ? t.next.kind === "queued"
          ? ["排队", "gray"]
          : ["待办", "gray"]
        : t.done.result === "online"
          ? ["已上线", "gray"]
          : t.done.result === "merged"
            ? ["已合入", "gray"]
            : t.done.result === "failed"
              ? ["失败", "red"]
              : t.done.result === "cancelled"
                ? ["取消", "gray"]
                : ["完成", "gray"];
  const ORDER = [
    "进行中",
    "等合入",
    "卡住",
    "排队",
    "待办",
    "已合入",
    "已上线",
    "完成",
    "失败",
    "取消",
  ];
  const rows = [...list]
    .sort((a, b) => ORDER.indexOf(tag(a)[0]) - ORDER.indexOf(tag(b)[0]))
    .slice(0, 60)
    .map((t) => {
      const [label, tone] = tag(t);
      const took = t.started ? duration((t.ended ?? NOW) - t.started) : "—";
      const recent = t.now?.text ?? t.next?.text ?? "";
      return `<div class="row" role="row">
        ${cell("任务", `<span class="task-ref">${t.ref}</span><span class="task-title">${esc(t.title)}</span>`, " name plain task")}
        ${cell("专员", t.job ? chipLink(ROLES[t.job], "role", `#${t.job}`) : none)}
        ${cell("状态", t.urgent ? `<span class="chips">${chip("紧急", "red")}${chip(label, tone)}</span>` : chip(label, tone))}
        ${cell("谁在做", t.worker ? `<span class="chip chip-soft clip">${esc(workerLabel(t.worker))}</span>` : none)}
        ${cell("用时", took, " muted tagged")}
        ${cell("最近在做", recent ? `<span class="clamp">${esc(recent)}</span>` : none, " note")}
      </div>`;
    });
  return `<div class="table table-tasks" role="table">
    <div class="row head" role="row">${["任务", "专员", "状态", "谁在做", "用时", "最近在做"].map((h) => `<span role="columnheader">${h}</span>`).join("")}</div>
    ${rows.join("")}
  </div>`;
}

// ---- 页 ----

function parse() {
  const raw = decodeURIComponent(location.hash.slice(1));
  const parts = raw.split("/");
  let page = "node";
  let ref = "o1";
  let rest = parts;
  if (parts[0] === "w") {
    page = "worker";
    ref = parts[1] || W.opus;
    rest = parts.slice(2);
  } else if (/^r\d+$/.test(parts[0])) {
    page = "role";
    ref = parts[0];
    rest = parts.slice(1);
  } else if (/^o\d+$/.test(parts[0])) {
    ref = parts[0];
    rest = parts.slice(1);
  } else if (parts[0].startsWith("find=")) rest = parts;
  const mode = rest[0] ?? "";
  return {
    page,
    ref,
    key: page === "worker" ? `w/${ref}` : ref,
    before: mode === "before",
    empty: mode === "empty",
    more: mode === "more",
    find: mode.startsWith("find=") ? mode.slice(5) : "",
  };
}

function subtree(ref) {
  const out = new Set([ref]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, n] of Object.entries(NODES))
      if (n.parent && out.has(n.parent) && !out.has(id)) {
        out.add(id);
        grew = true;
      }
  }
  return out;
}

function tasksOf(r) {
  const all = r.more ? [...TASKS, ...olderDone(20)] : TASKS;
  if (r.empty) return [];
  let list = all;
  if (r.page === "node") {
    const within = subtree(r.ref);
    list = all.filter((t) => within.has(t.part));
  } else if (r.page === "role") list = all.filter((t) => t.job === r.ref);
  else list = all.filter((t) => t.worker === r.ref);
  if (r.find) {
    const q = r.find.toLowerCase();
    list = list.filter((t) => t.ref === q || t.title.toLowerCase().includes(q));
  }
  return list;
}

function head(r) {
  if (r.page === "role")
    return {
      kind: "专员",
      name: ROLES[r.ref],
      crumbs: ["你的 AI 组织", "专员", ROLES[r.ref]],
      intro: "负责网页、菜单栏面板这类给人看的界面。",
      tabs: ["任务", "谁做得好", "技能"],
    };
  if (r.page === "worker")
    return {
      kind: "执行者",
      name: workerLabel(r.ref),
      crumbs: ["你的 AI 组织", "执行者", workerLabel(r.ref)],
      intro: "",
      // 原「交付记录」并进「任务」：做完了一组就是交付记录。
      tabs: ["任务", "观察"],
    };
  const chain = [];
  for (let c = r.ref; c; c = NODES[c].parent) chain.unshift(NODES[c].name);
  return {
    kind: { org: "组织", project: "部分", module: "部分" }[NODES[r.ref].kind],
    name: NODES[r.ref].name,
    crumbs: chain,
    intro: WHAT[r.ref] ?? "",
    tabs:
      r.ref === "o1"
        ? [
            "组成部分",
            "任务",
            "负责人",
            "专员",
            "技能",
            "执行者",
            "原则",
            "巡检发现",
          ]
        : ["组成部分", "任务", "原则", "巡检发现"],
  };
}

function draw() {
  const r = parse();
  const h = head(r);
  const list = tasksOf(r);
  const open = list.filter((t) => t.now || t.next).length;
  // 顶栏与状态栏同一个数：执行者在做的件数。
  const running = list.filter((t) => t.now?.kind === "worker").length;
  $("crumbs").innerHTML = h.crumbs
    .map((c, i) =>
      i === h.crumbs.length - 1
        ? `<span class="crumb current">${esc(c)}</span>`
        : `<a class="crumb" href="#o1">${esc(c)}</a>`,
    )
    .join(`<span class="sep" aria-hidden="true">/</span>`);
  $("live").textContent = running
    ? `${r.page === "node" ? "" : "全组织"}在做 ${running} 件`
    : "都停着";
  const tabs = h.tabs
    .map(
      (t) =>
        `<a class="tab" role="tab" href="#${r.key}" aria-selected="${t === "任务"}"><span>${esc(t)}</span>${t === "任务" ? `<span class="badge">${open}</span>` : ""}</a>`,
    )
    .join("");
  const search = r.before
    ? `<div class="filters"><a class="filter" href="#${r.key}">进行中</a><a class="filter" aria-current="true" href="#${r.key}/before">全部</a></div>`
    : `<div class="filters"><label class="find"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg><input id="find" type="search" placeholder="找任务：编号或标题" value="${esc(r.find)}" aria-label="找任务" /></label></div>`;
  const body = r.before ? beforeTable(list) : groups(list, r);
  $("page").innerHTML = `<header class="intro">
      <span class="kind">${esc(h.kind)}</span>
      <h1>${esc(h.name)}</h1>
      ${h.intro ? `<p>${esc(h.intro)}</p>` : ""}
    </header>
    <section class="view">
      <div class="tabbar"><div class="tabs" role="tablist" aria-label="视图">${tabs}</div>${search}</div>
      <div role="tabpanel" class="tg-panel">${body}</div>
    </section>`;
  const input = $("find");
  if (input)
    input.addEventListener("change", () => {
      location.hash = input.value.trim()
        ? `${r.key}/find=${input.value.trim()}`
        : r.key;
    });
  document.title = `${h.name} · 任务视图原型`;
}

window.addEventListener("hashchange", draw);
draw();
