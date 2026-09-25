import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  branchPreview,
  isBranch,
  jsonString,
  parseBranch,
} from "../web/components/json-tree.ts";

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
