import { test } from "node:test";
import assert from "node:assert/strict";
import {
  askText,
  hasConclusion,
  shouldAsk,
  type ConclusionKind,
} from "../server/tasks/conclusion.ts";
import type { Exit, Stop } from "../server/tasks/outcome.ts";

const KINDS: ConclusionKind[] = ["review"];

test("结论补答：审阅认最后一行的审阅结论", () => {
  const good: Record<ConclusionKind, string> = {
    review: "1. a.ts:3 没处理空值\n审阅结论：打回",
  };
  for (const kind of KINDS) {
    assert.equal(hasConclusion(kind, good[kind]), true, kind);
    assert.equal(hasConclusion(kind, "看起来都挺好"), false, kind);
    assert.equal(hasConclusion(kind, ""), false, kind);
  }
  assert.equal(hasConclusion("review", "结论：通过"), false);
});

test("结论补答：捎话写明只补结论、不改文件，并给出该类的格式", () => {
  for (const kind of KINDS) {
    const text = askText(kind);
    assert.match(text, /没有按格式写结论/);
    assert.match(text, /不要改文件/);
  }
  assert.match(askText("review"), /`审阅结论：通过` 或 `审阅结论：打回`/);
});

test("结论补答穷举：类别 × 退出 × 停止 × 是否补答过 × 有没有结论", () => {
  const exits: Exit[] = [
    { code: 0, signal: null },
    { code: 1, signal: null },
    { code: null, signal: "SIGTERM" },
    "unknown",
  ];
  const stops: (Stop | undefined)[] = [
    undefined,
    { kind: "user" },
    { kind: "stalled", reason: "卡死" },
  ];
  let cases = 0;
  for (const kind of [...KINDS, undefined])
    for (const exit of exits)
      for (const stop of stops)
        for (const asked of [false, true])
          for (const text of [
            "没写结论",
            "审阅结论：通过\n结论：通过\n意见：同意",
          ]) {
            cases++;
            const clean =
              exit === "unknown" || (exit.code === 0 && exit.signal === null);
            const expected =
              kind !== undefined &&
              clean &&
              !stop &&
              !asked &&
              !hasConclusion(kind, text);
            assert.equal(
              shouldAsk({ kind, exit, stop, asked, text }),
              expected,
              JSON.stringify({ kind, exit, stop, asked, text }),
            );
          }
  assert.equal(cases, 2 * 4 * 3 * 2 * 2);
  // 正常结束、没补答过、读不出结论的才补答
  assert.equal(
    shouldAsk({
      kind: "review",
      exit: { code: 0, signal: null },
      asked: false,
      text: "都挺好",
    }),
    true,
  );
});
