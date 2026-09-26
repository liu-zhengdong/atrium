/**
 * 事件投递的判定（#262）：纯函数。wait 交出去的事件进入「处理中」，租约内不重投，超时仍未 ack 才重投；
 * ack 后永不再投；订阅者自己发起的动作产生的事件照样落库，但不投给他本人。
 * events.ts 里的查询条件与这里一一对应，测试逐格对照两者。
 */

/** 处理中租约缺省 15 分钟。 */
export const LEASE_MS = 15 * 60_000;

export type DeliveryState = {
  subscriber: string;
  /** 发起者：谁的动作引出了这条事件；执行者、CI 等自发的为 null。 */
  actor: string | null;
  ready_at: number;
  /** 最近一次交给订阅者的时间；租约从这里起算，内容合并更新时清空。 */
  delivered_at: number | null;
  acked_at: number | null;
};

export const selfInitiated = (subscriber: string, actor: string | null) =>
  actor !== null && actor === subscriber;

export function deliverable(row: DeliveryState, now: number, leaseMs: number) {
  if (row.acked_at !== null) return false;
  if (selfInitiated(row.subscriber, row.actor)) return false;
  if (row.ready_at > now) return false;
  return row.delivered_at === null || row.delivered_at + leaseMs <= now;
}

/** 租约到期时间：已交出、未 ack、不是自己发起的才有；wait 据此定时醒来检查。 */
export function leaseExpiry(row: DeliveryState, leaseMs: number) {
  if (row.acked_at !== null || row.delivered_at === null) return undefined;
  if (selfInitiated(row.subscriber, row.actor)) return undefined;
  return row.delivered_at + leaseMs;
}
