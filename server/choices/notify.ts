import type { DatabaseSync } from "node:sqlite";
import { SECRETARY } from "../leaders/route.ts";
import { partRoute } from "../leaders/subscriber.ts";
import { nodeByAddress } from "../org/model.ts";
import type { EventInbox } from "../tasks/events.ts";
import type { Choice } from "./store.ts";

/**
 * 选项单的事件投递（接口与产品部研究收尾共用）：建好后项目 leader 收 choice_review（写意见）；
 * 拍板人是用户时秘书收 choice_ready（叫醒），下放时 leader 收 choice_ready、秘书只收知会 choice_notice。
 */

export const choiceBrief = (choice: Choice) => ({
  choice: choice.ref,
  title: choice.title,
  node: choice.node,
  node_name: choice.node_name,
  options: choice.options.length,
  status: choice.status,
  decider: choice.decider,
});

/** 选项单所在节点最近的 leader；没有为 null。 */
export function choiceLeader(db: DatabaseSync, choice: Choice): string | null {
  const subscriber = partRoute(
    db,
    nodeByAddress(db, choice.node).id,
  ).subscriber;
  return subscriber === SECRETARY ? null : subscriber;
}

export function publishChoice(
  inbox: EventInbox,
  subscriber: string,
  kind: string,
  choice: Choice,
  actor: string | undefined,
  detail: Record<string, unknown>,
) {
  inbox.publish({
    subscriber,
    source: "choice",
    kind,
    key: `choice:${choice.ref}`,
    actor,
    detail: { ...choiceBrief(choice), ...detail },
  });
}

/** 新选项单：按拍板人叫醒秘书或 leader，并请项目 leader 写意见。creator 是 leader 短号，秘书为 undefined。 */
export function announceChoice(
  db: DatabaseSync,
  inbox: EventInbox,
  choice: Choice,
  creator: string | undefined,
) {
  const leader = choiceLeader(db, choice);
  const show = `atrium choice show ${choice.ref}`;
  if (choice.decider === "u1") {
    publishChoice(inbox, SECRETARY, "choice_ready", choice, creator, {
      task: choice.task,
      hint: `${choice.node_name}有一份新的选项单等用户拍板：${show}；可以和别的产品部的选项合并、去重后一起递给用户，但不删改方向；用户在全景网页或 atrium choice pick ${choice.ref} 选项号 里拍板`,
    });
    if (leader && leader !== creator)
      publishChoice(inbox, leader, "choice_review", choice, creator, {
        hint: `${choice.node_name}有一份新的选项单，拍板人是用户；先看 ${show}，可以写意见、补依据、标倾向：atrium choice comment ${choice.ref} 意见 --prefer 选项号 --basis 依据；不能拍板`,
      });
    return;
  }
  if (choice.decider !== creator)
    publishChoice(inbox, choice.decider, "choice_ready", choice, creator, {
      hint: `${choice.node_name}的选项单由你拍板（${choice.decider_why}）：先看 ${show}，再 atrium choice pick ${choice.ref} 选项号 --note 说明，或 atrium choice pass ${choice.ref} --note 原因`,
    });
  publishChoice(inbox, SECRETARY, "choice_notice", choice, creator, {
    hint: `${choice.node_name}有一份新的选项单，拍板权已下放给 ${choice.decider}，只需知会用户：${show}`,
  });
}
