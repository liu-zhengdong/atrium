import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, oneLine, width } from "../server/text-width.ts";

test("显示宽度：汉字与全角标点两格，英文数字一格", () => {
  assert.equal(width(""), 0);
  assert.equal(width("abc"), 3);
  assert.equal(width("审阅"), 4);
  assert.equal(width("审阅 t132：打回"), 15);
  assert.equal(width("（t1）"), 6);
});

test("单行截断：多行取第一行有字的，压空白，超宽加省略号", () => {
  assert.equal(oneLine("", 10), "");
  assert.equal(oneLine("\n\n  \n", 10), "");
  assert.equal(oneLine("第一行\n第二行", 20), "第一行");
  assert.equal(oneLine("\n\n  第一行  \r\n第二行", 20), "第一行");
  assert.equal(oneLine("a\t  b", 10), "a b");
  // 刚好放得下不截。
  assert.equal(oneLine("一二三四五", 10), "一二三四五");
  // 超出：省略号算一格，汉字不劈开。
  assert.equal(oneLine("一二三四五六", 10), "一二三四…");
  assert.equal(oneLine("abcdefghijk", 5), "abcd…");
  // 中英混排按显示宽度截。
  const mixed = oneLine("审阅打回：task ls 实测 240 毫秒超过要点", 20);
  assert.equal(mixed, "审阅打回：task ls…");
  assert.ok(width(mixed) <= 20);
  for (let max = 1; max <= 40; max++) {
    const cut = oneLine("中a文b混c排d的e一f段g很h长i的j文k字l\n第二行", max);
    assert.ok(width(cut) <= max, `max=${max} 得到 ${cut}`);
    assert.ok(!cut.includes("第二行"));
  }
  assert.equal(oneLine("x".repeat(100), Infinity), "x".repeat(100));
  // clip 保留原意：把各行并成一行。
  assert.equal(clip("第一行\n第二行", 20), "第一行 第二行");
});
