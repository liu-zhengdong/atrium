/** 本机唯一的操作者，短号全局一致、持久、不复用。 */
export const LOCAL_USER = "u1";

/** 秘书：拿用户令牌替用户办事；修订与事件如实记 secretary，权限与用户相同。 */
export const SECRETARY = "secretary";

/** 这个操作者是否带用户的权限（用户本人，或用户令牌下以秘书名义）。 */
export const actsForUser = (actor: string) =>
  actor === LOCAL_USER || actor === SECRETARY;
