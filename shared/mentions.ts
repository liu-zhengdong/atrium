/** @ 全体的保留写法，两种叫法都认。 */
export const MENTION_ALL = "全体";

// @ 前面紧挨英文字母、数字或 . @ / + - 时不算点名，排除邮箱、包名这类写法；中文紧挨着可以。
const START = String.raw`(?<![A-Za-z0-9_.@/+\-])@`;
// 名字后面不能再接字母、数字或下划线，@Atlas 不会误认 @AtlasPlus；标点、空白和行尾都算结束。
const END = String.raw`(?![\p{L}\p{N}_])`;
const allPattern = new RegExp(`${START}(?:全体|所有人)${END}`, "u");

/** 代码块和行内代码里的 @ 是在引用文本，不是点名。 */
const withoutCode = (body: string) =>
  body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");

export const mentionsAll = (body: string) => allPattern.test(withoutCode(body));

/** 正文里用 @名称 或 @短号（如 @a1）点到的人，按出现顺序去重。 */
export function resolveMentions(
  body: string,
  agents: { id: string; name: string; ref?: string }[],
): string[] {
  const byHandle = new Map<string, string>();
  for (const agent of agents) byHandle.set(agent.name, agent.id);
  // 短号唯一，和别人的名字撞上时以短号为准。
  for (const agent of agents) if (agent.ref) byHandle.set(agent.ref, agent.id);
  if (!byHandle.size) return [];
  const handles = [...byHandle.keys()]
    .sort((a, b) => b.length - a.length)
    .map((handle) => handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`${START}(${handles.join("|")})${END}`, "gu");
  return [
    ...new Set(
      [...withoutCode(body).matchAll(pattern)].map((match) =>
        byHandle.get(match[1]!)!,
      ),
    ),
  ];
}
