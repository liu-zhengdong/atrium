/**
 * `org show` 的目标链：根 → 本节点逐层列目标，每个节点只出现一次，空目标跳过。
 * 上层目标里按「子节点名：目标」写给各子节点的行（如根章程里的「Atrium：…」「OpenQuota：…」）不在上层重复：
 * 链上的子节点自己有目标就由它那一层列出，不在链上的子节点与本节点无关；链上子节点目标为空时保留上层那一行。
 * 链尾（本节点）自己的目标原样列出，写给子节点的行也保留。
 * 与下层目标全文相同的行也去掉。
 */

export type GoalLevel = {
  ref: string;
  name: string;
  goal: string;
  /** 直接子节点的显示名 */
  children: string[];
};

type GoalLink = { ref: string; name: string; goal: string };

const LABELED = /^\s*(?:[-*]\s*)?([^：:\n]{1,40})[：:]\s*(.*)$/;

export function goalChain(levels: readonly GoalLevel[]): GoalLink[] {
  const goals = levels.map((level) => level.goal.trim());
  return levels
    .map((level, i) => {
      const next = levels[i + 1];
      const below = new Set(goals.slice(i + 1).filter(Boolean));
      const lines = goals[i]!.split("\n").filter((line) => {
        const text = line.trim();
        if (!text || below.has(text)) return false;
        const label = LABELED.exec(text);
        if (!next || !label || !level.children.includes(label[1]!.trim()))
          return true;
        return label[1]!.trim() === next.name && !goals[i + 1] && !!label[2];
      });
      return { ref: level.ref, name: level.name, goal: lines.join("\n") };
    })
    .filter((link) => link.goal !== "");
}
