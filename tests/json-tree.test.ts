import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  branchPreview,
  isBranch,
  jsonString,
  parseBranch,
} from "../web/components/json-tree.ts";
import { TraceValue } from "../web/components/JsonTree.tsx";

test("整段能解析成对象或数组才按 JSON 树显示", () => {
  assert.deepEqual(parseBranch('{"server":"atrium","tool":"send_message"}'), {
    server: "atrium",
    tool: "send_message",
  });
  assert.deepEqual(parseBranch("  [1, 2, 3]\n"), [1, 2, 3]);
  assert.deepEqual(parseBranch("{}"), {});
});

test("其余照旧显示原文", () => {
  assert.equal(parseBranch("$ npm test\nok"), null);
  assert.equal(parseBranch("收到，我这边看一下"), null);
  assert.equal(parseBranch('"只是一个字符串"'), null);
  assert.equal(parseBranch("42"), null);
  assert.equal(parseBranch("true"), null);
  assert.equal(parseBranch(""), null);
  assert.equal(parseBranch("   "), null);
  // 被截断的 JSON：服务端只留前 8,192 个字符，解析不了就退回原文。
  assert.equal(parseBranch('{"a":1,"b":'), null);
  assert.equal(parseBranch('{"a":1} 后面还有话'), null);
});

test("字符串值本身是对象或数组时也展开成子树", () => {
  assert.deepEqual(jsonString('{"content":[{"type":"text"}]}'), {
    content: [{ type: "text" }],
  });
  assert.deepEqual(jsonString(" [1,2] "), [1, 2]);
  assert.equal(jsonString("项目开工了"), null);
  assert.equal(jsonString("{没写完"), null);
});

test("收起时的一行预览", () => {
  assert.equal(branchPreview([1, 2, 3]), "[3 项]");
  assert.equal(branchPreview([]), "[0 项]");
  assert.equal(
    branchPreview({ chat_id: "c28", body: "收到" }),
    '{chat_id: "c28", body: "收到"}',
  );
  // 多于三个字段时报省略号，长字符串截断并保留引号。
  assert.equal(
    branchPreview({ a: 1, b: true, c: null, d: "不再显示" }),
    "{a: 1, b: true, c: null, …}",
  );
  assert.equal(
    branchPreview({ body: "这是一段很长的中文消息正文，应该被截断" }),
    '{body: "这是一段很长的中文消息正文，应该被截断"}',
  );
  assert.equal(
    branchPreview({ body: "0123456789".repeat(5) }),
    '{body: "0123456789012345678901234567890123456789…"}',
  );
  // 嵌套的容器只报形状。
  assert.equal(branchPreview({ args: { server: "atrium" } }), "{args: {…}}");
  assert.equal(branchPreview({ items: [1, 2] }), "{items: [2 项]}");
  assert.equal(
    branchPreview({
      server: "atrium",
      tool: "atrium_send_message",
      args: { chat_id: "c28" },
    }),
    '{server: "atrium", tool: "atrium_send_message", args: {…}}',
  );
});

test("对象与数组之外的值不是分支", () => {
  assert.equal(isBranch(null), false);
  assert.equal(isBranch("text"), false);
  assert.equal(isBranch(7), false);
  assert.equal(isBranch([1]), true);
  assert.equal(isBranch({}), true);
});

// 渲染层的三条：字符串返回值对，拼出来的文字不一定对（收起时的括号、空串、空容器）。
function markupText(text: string): string {
  return renderToStaticMarkup(
    createElement(TraceValue, { label: "调用参数", text }),
  )
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

test("收起节点不重复括号：预览自带括号", () => {
  const text = markupText('{"a": {"b": [1, 2, 3]}}');
  assert.match(text, /b: \[3 项\]/);
  assert.ok(!text.includes("[[3 项]]"), text);
});

test("收起对象预览是 {前三个字段, …}", () => {
  const text = markupText('{"a": {"b": {"c": 1, "d": 2, "e": 3, "f": 4}}}');
  assert.match(text, /b: \{c: 1, d: 2, e: 3, …\}/);
  assert.ok(!text.includes("{{"), text);
});

test("空字符串、全空白字符串带引号显示", () => {
  const text = markupText('{"empty": "", "spaces": "  "}');
  assert.match(text, /empty: ""/);
  assert.match(text, /spaces: "  "/);
});

test("空数组与空对象显示成 [] 和 {}，没有三角", () => {
  const text = markupText('{"a": [], "b": {}}');
  assert.match(text, /a: \[\]/);
  assert.match(text, /b: \{\}/);
});

test("null 用调色板里的 muted 色，不靠颜色区分字符串", () => {
  const html = renderToStaticMarkup(
    createElement(TraceValue, {
      label: "执行结果",
      text: '{"a": null, "b": "文字"}',
    }),
  );
  assert.match(html, /text-\[#5c685f\] italic/);
  assert.ok(!html.includes("#9a8f80"), html);
  assert.match(markupText('{"a": null, "b": "文字"}'), /b: "文字"/);
});
