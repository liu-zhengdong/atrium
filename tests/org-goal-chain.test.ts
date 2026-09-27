import { test } from "node:test";
import assert from "node:assert/strict";
import { goalChain, type GoalLevel } from "../server/org/goal-chain.ts";

const level = (
  ref: string,
  name: string,
  goal: string,
  children: string[] = [],
): GoalLevel => ({ ref, name, goal, children });

const root = level(
  "o1",
  "组织",
  "Atrium：成为 AI 组织的运行底座\nOpenQuota：各家订阅额度看得清",
  ["Atrium", "OpenQuota"],
);

test("goalChain：根章程里写给子项目的目标不与项目目标重复，旁支项目不列", () => {
  assert.deepEqual(
    goalChain([
      root,
      level("o2", "Atrium", "成为 AI 组织的运行底座", ["runtime", "cli"]),
      level("o5", "runtime", ""),
    ]),
    [{ ref: "o2", name: "Atrium", goal: "成为 AI 组织的运行底座" }],
  );
});

test("goalChain：按组织 → 项目 → 模块逐层列，每个节点只出现一次", () => {
  const chain = goalChain([
    level("o1", "组织", "让用户只提目标\nAtrium：底座", ["Atrium"]),
    level("o2", "Atrium", "底座", ["runtime"]),
    level("o5", "runtime", "服务稳定"),
  ]);
  assert.deepEqual(
    chain.map((c) => [c.name, c.goal]),
    [
      ["组织", "让用户只提目标"],
      ["Atrium", "底座"],
      ["runtime", "服务稳定"],
    ],
  );
  assert.equal(new Set(chain.map((c) => c.ref)).size, chain.length);
});

test("goalChain：看的就是上层节点时，写给子节点的行照常列出", () => {
  assert.deepEqual(goalChain([root]), [
    { ref: "o1", name: "组织", goal: root.goal },
  ]);
});

test("goalChain：链上子节点目标为空时保留上层写给它的那一行", () => {
  assert.deepEqual(goalChain([root, level("o2", "Atrium", "", ["runtime"])]), [
    { ref: "o1", name: "组织", goal: "Atrium：成为 AI 组织的运行底座" },
  ]);
});

test("goalChain：与下层全文相同的行去掉；不是子节点名的标签行保留；空目标跳过", () => {
  assert.deepEqual(
    goalChain([
      level("o1", "组织", "  \n", ["Atrium"]),
      level("o2", "Atrium", "当前阶段：跑通派活\n底座", ["runtime"]),
      level("o5", "runtime", "底座"),
    ]),
    [
      { ref: "o2", name: "Atrium", goal: "当前阶段：跑通派活" },
      { ref: "o5", name: "runtime", goal: "底座" },
    ],
  );
  assert.deepEqual(goalChain([]), []);
  assert.deepEqual(goalChain([level("o1", "组织", "")]), []);
});
