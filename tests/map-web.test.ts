import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, linkify, liveText } from "../server/map/web/format.js";
import {
  fetchRootOrg,
  keepWorkers,
  sseReloadOnHello,
  withWorkers,
} from "../server/map/web/boot.js";

test("全景网页转义：尖括号、引号与 & 都变成实体", () => {
  assert.equal(
    escapeHtml(`<img src="x" onerror='a'>&`),
    "&lt;img src=&quot;x&quot; onerror=&#39;a&#39;&gt;&amp;",
  );
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("最近动作里的 http(s) 链接渲染成新标签页外链，其余文本照常转义", () => {
  const html = linkify(
    "已开 PR：https://github.com/liu-zhengdong/atrium/pull/357 待审",
  );
  assert.match(
    html,
    /<a href="https:\/\/github\.com\/liu-zhengdong\/atrium\/pull\/357" target="_blank" rel="noopener">https:\/\/github\.com\/liu-zhengdong\/atrium\/pull\/357<\/a>/,
  );
  assert.match(html, /^已开 PR：/);
  assert.match(html, /待审$/);
  assert.doesNotMatch(html, /<a[^>]*>已开 PR/);
});

test("链接只认 http(s)：别的协议与 HTML 都当纯文本转义，不引入 XSS", () => {
  const evil = linkify(
    `<img src=x onerror=alert(1)> javascript:alert(2) data:text/html,x https://x.test/y?a=1&b=2`,
  );
  assert.doesNotMatch(evil, /<img/);
  assert.doesNotMatch(evil, /<a href="javascript/);
  assert.doesNotMatch(evil, /<a href="data:/);
  assert.match(evil, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(evil, /<a href="https:\/\/x\.test\/y\?a=1&amp;b=2"/);
});

test("顶栏在做数看当前部门（含下属部门），角色与执行者页显示全组织", () => {
  const node = {
    page: "node",
    node: { counts: { running: 2, blocked: 0, open: 5 } },
  };
  assert.equal(liveText("node", node, { running: 9 }), "在做 2 件");
  assert.equal(
    liveText(
      "node",
      { page: "node", node: { counts: { running: 0 } } },
      { running: 9 },
    ),
    "都停着",
  );
  assert.equal(
    liveText("role", { page: "role" }, { running: 9 }),
    "全组织在做 9 件",
  );
  assert.equal(
    liveText("worker", { page: "worker" }, { running: 0 }),
    "都停着",
  );
  assert.equal(liveText("node", node, null), "在做 2 件");
});

test("组织根首屏不取执行者统计，画完再补", async () => {
  const paths: string[] = [];
  const get = async (path: string) => {
    paths.push(path);
    if (path.startsWith("/nodes/")) return { ref: "o1" };
    if (path.startsWith("/specialists")) return { specialists: [] };
    if (path === "/skills") return { skills: [] };
    if (path === "/leaders") return { leaders: [] };
    throw new Error(`首屏不该取 ${path}`);
  };
  const page = await fetchRootOrg(get, "o1");
  assert.equal(
    paths.some((p) => p === "/workers" || p.startsWith("/workers?")),
    false,
  );
  assert.equal(page.org.workers.pending, true);
  assert.equal(page.org.workers.rows.length, 0);
  const filled = withWorkers(page, {
    role: null,
    rows: [{ worker: "claude" }],
    suggestions: [],
  });
  assert.equal(filled.org.workers.pending, false);
  assert.equal(filled.org.workers.rows.length, 1);
  const kept = keepWorkers(
    { org: { workers: { pending: true, rows: [] } } },
    filled,
  );
  assert.equal(kept.org.workers.pending, false);
  assert.equal(kept.org.workers.rows.length, 1);
});

test("SSE 第一次 hello 不重取，重连才重取", () => {
  assert.equal(sseReloadOnHello(false), false);
  assert.equal(sseReloadOnHello(true), true);
});
