import { Problem } from "../problem.ts";
import { LIMITS, SLUG_RE, validateFiles } from "./model.ts";
import type { MountSkill } from "./mount.ts";
import type { TaskSkill } from "./task-skills.ts";

/**
 * 远程主机上的组织技能（t232）：服务把这次要挂的技能（内容 + 修订号）随拉起指令交给代理，
 * 代理在那台的任务目录里用本机同一个 `mountSkills` 挂上，把「本次挂载的技能」段填进提示词的占位处。
 */

/** 提示词里「本次挂载的技能」段的占位：挂在哪、挂没挂上只有代理知道。 */
export const SKILLS_SLOT = "<!-- atrium:skills -->";

/** 随拉起指令下发的一个技能。 */
export type SkillCopy = MountSkill;

/** 拉起回执里的挂载结果：挂上了哪些（slug@rN），或挂不上的原因。 */
export type SkillMountAck = { mounted: string[]; error?: string };

export const copyOf = (skill: TaskSkill): SkillCopy => ({
  id: skill.id,
  slug: skill.slug,
  rev: skill.rev,
  description: skill.description,
  via: skill.via,
  files: skill.files,
});

/** 把占位换成代理算出的段落；挂不上时写明原因，免得执行者按不存在的路径去找。 */
export function fillSkillSlot(
  prompt: string,
  fill: { section: string } | { error: string } | undefined,
): string {
  if (!prompt.includes(SKILLS_SLOT)) return prompt;
  const text = !fill
    ? ""
    : "section" in fill
      ? fill.section
      : `这次原本要带的组织技能没挂上（${fill.error}），按任务详述与岗位说明干活。`;
  return prompt.replace(SKILLS_SLOT, () => text);
}

const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** 代理这一侧：服务派来的技能能不能照写进自己的数据目录（slug 是目录名，文件路径只能在技能目录内）。 */
export function skillCopiesRefusal(skills: unknown): string | null {
  if (skills === undefined) return null;
  if (!Array.isArray(skills)) return "技能清单不合法";
  if (skills.length > LIMITS.perTask) return `技能超过 ${LIMITS.perTask} 个`;
  const seen = new Set<string>();
  for (const skill of skills as Partial<SkillCopy>[]) {
    if (typeof skill !== "object" || skill === null) return "技能清单不合法";
    if (
      typeof skill.slug !== "string" ||
      skill.slug.length > 64 ||
      !SLUG_RE.test(skill.slug)
    )
      return `技能名不合法：${String(skill.slug).slice(0, 64)}`;
    if (seen.has(skill.slug)) return `技能 ${skill.slug} 重复`;
    seen.add(skill.slug);
    if (!positive(skill.id) || !positive(skill.rev))
      return `技能 ${skill.slug} 的编号或修订号不合法`;
    if (typeof skill.description !== "string" || typeof skill.via !== "string")
      return `技能 ${skill.slug} 缺少简介或来源`;
    try {
      validateFiles(skill.files);
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      return `技能 ${skill.slug} 的文件不合法：${error.message}`;
    }
  }
  return null;
}
