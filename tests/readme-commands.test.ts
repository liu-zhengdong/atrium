import { test } from "node:test";
import assert from "node:assert/strict";
import { commands, service, type Command } from "../cli/main.ts";
import { groups } from "../cli/guide.ts";
import { begin, end, reference, withReference } from "../cli/readme.ts";

test("命令参考段含命令表的每条命令与服务入口，按分组排，同一份命令表生成结果不变", () => {
  const text = reference(commands, service);
  assert.equal(reference(commands, service), text);
  for (const [name, command] of Object.entries(commands))
    assert(text.includes(`atrium ${name} ${command.args}`.trimEnd()), name);
  for (const usage of ["atrium", "atrium status", "atrium stop"])
    assert.match(text, new RegExp(`^${usage}\\n  \\S`, "m"), usage);
  const headings = [...text.matchAll(/^### (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(
    headings.filter((heading) => heading !== "其他"),
    Object.keys(groups),
  );
  assert(text.indexOf("atrium task add ") < text.indexOf("atrium task ls "));
  assert(!/\d{4}-\d{2}-\d{2}/.test(text), "不带日期");
});

test("没归进分组的命令放在「其他」，不会漏掉", () => {
  const fake: Command = {
    args: "[--x]",
    about: "新命令",
    positionals: [0, 0],
    run: async () => {},
  };
  const text = reference({ ...commands, "zzz new": fake }, service);
  assert.match(
    text,
    /### 其他\n\n```text\n[\s\S]*atrium zzz new \[--x\]\n  新命令\n/,
  );
});

test("只换起止标记之间的内容；段外不动、可重复执行、保留换行风格", () => {
  const readme = `# 标题\n\n手写前文\n\n${begin}\n旧的\n${end}\n\n手写后文\n`;
  const once = withReference(readme, "### 服务\n\n新的");
  assert.equal(
    once,
    `# 标题\n\n手写前文\n\n${begin}\n\n### 服务\n\n新的\n\n${end}\n\n手写后文\n`,
  );
  assert.equal(withReference(once, "### 服务\n\n新的"), once);
  const crlf = withReference(readme.replaceAll("\n", "\r\n"), "新的");
  assert(crlf.includes(`${begin}\r\n\r\n新的\r\n\r\n${end}\r\n`));
  assert(!/[^\r]\n/.test(crlf));
});

test("起止标记缺失、重复或颠倒时报错，不猜位置", () => {
  for (const broken of [
    "没有标记",
    `${begin}\n只有开始`,
    `${end}\n${begin}`,
    `${begin}\n${end}\n${begin}\n${end}`,
  ])
    assert.throws(() => withReference(broken, "x"), /起止标记/, broken);
});
