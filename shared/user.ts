import { z } from "zod";

/** 用户是一等身份，短号与 a1 / c1 同类：全局一致、持久、不复用。 */
const reference = /^u[1-9][0-9]{0,14}(?![\s\S])/;
/** 本机唯一的操作者。多用户到来前，所有人类发言与上传都记在它名下。 */
export const LOCAL_USER = "u1";
export const userReference = z
  .string()
  .trim()
  .regex(reference, "请使用用户短号，如 u1")
  .describe("用户短号，如 u1");
/** 消息发送者、附件上传者是用户还是 Agent：Agent 用 UUID，用户用短号。 */
export const isUserRef = (sender: string) => reference.test(sender);

export const USER_NAME_MAX = 40;
export const USER_PROFILE_MAX = 4000;
/** 用户自己维护的资料，Atrium 保存；与 Agent 的笔记是两回事。 */
export type UserProfile = {
  id: string;
  name: string;
  profile: string;
  updated_at: number;
};
/** 整体替换，与 Agent 资料的写法一致：两个字段都要给出当前值。 */
export const userProfileInput = z
  .object({
    name: z
      .string()
      .trim()
      .max(USER_NAME_MAX)
      .regex(/^[^\n\r\t]*$/, "称呼不能换行"),
    profile: z.string().trim().max(USER_PROFILE_MAX),
  })
  .strict();
