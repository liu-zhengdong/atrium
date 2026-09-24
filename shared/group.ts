import { z } from "zod";

export const NOTICE_MAX = 500;

/**
 * 群名只用于显示，不做目录名，所以比 Agent 名（displayName）宽：
 * 允许 # （）：这些常见字符，只拦换行与控制字符。
 */
export const groupName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^\p{Cc}]+$/u, "群名不能包含换行或控制字符");

/** 整体替换：群名和公告一起给当前值，省掉一层「这个字段有没有传」。 */
export const groupProfileInput = z
  .object({
    name: groupName,
    notice: z.string().trim().max(NOTICE_MAX),
  })
  .strict();

/** 删除群前的共享目录文件数；目录太大时列表只数到上限，带 + 标出来。 */
export function filesLabel(deletion: {
  files: number;
  files_truncated: boolean;
}): string {
  return deletion.files_truncated
    ? `${deletion.files}+`
    : String(deletion.files);
}
