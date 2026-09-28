import type { DatabaseSync } from "node:sqlite";
import { SECRETARY } from "../leaders/route.ts";
import { partRoute } from "../leaders/subscriber.ts";
import { nodeByAddress } from "../org/model.ts";
import type { EventInbox } from "../tasks/events.ts";
import { smallHint } from "./model.ts";
import { decideChoice, type Choice, type Decided } from "./store.ts";

/**
 * 选项单的事件投递（接口与产品部研究收尾共用）：建好后项目 leader 收 choice_review（写意见）；
 * 拍板人是用户时秘书收 choice_ready（叫醒），下放时 leader 收 choice_ready、秘书只收知会 choice_notice；
 * 拍板（接口、Telegram 按钮共用）后同一去重键改投知会 choice_decided。
 * 随单的小改进另投 choice_small 给建单时记下的项目 leader（没有 leader 为秘书），由它自己定，不进选项单。
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

/** 新选项单：按拍板人叫醒秘书或 leader，并请项目 leader 写意见；有小改进时交项目 leader 自己定。creator 是 leader 短号，秘书为 undefined。 */
export function announceChoice(
  db: DatabaseSync,
  inbox: EventInbox,
  choice: Choice,
  creator: string | undefined,
) {
  if (choice.small)
    inbox.publish({
      subscriber: choice.small.to,
      source: "choice",
      kind: "choice_small",
      key: `choice-small:${choice.ref}`,
      actor: creator,
      detail: {
        choice: choice.ref,
        node: choice.node,
        node_name: choice.node_name,
        task: choice.task,
        small: choice.small.items,
        hint: smallHint(
          choice.ref,
          { ref: choice.node, name: choice.node_name },
          choice.small.count,
        ),
      },
    });
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

/**
 * 拍板并投知会：秘书与该节点 leader 那条待办（choice_review / choice_ready）改成知会 choice_decided。
 * actor 是 u1（用户：命令行、全景网页、Telegram）或拍板权下放给的 leader。
 */
export function decideAndAnnounce(
  db: DatabaseSync,
  inbox: EventInbox,
  reference: unknown,
  action: "pick" | "pass",
  body: unknown,
  actor: string,
): Decided {
  const result = decideChoice(db, reference, action, body, actor);
  const detail = {
    decided_by: actor,
    tasks: result.tasks.map((t) => t.ref),
    decisions: result.decisions.map((d) => d.ref),
    note: result.choice.note,
  };
  publishChoice(
    inbox,
    SECRETARY,
    "choice_decided",
    result.choice,
    actor === "u1" ? undefined : actor,
    detail,
  );
  const leader = choiceLeader(db, result.choice);
  if (leader)
    publishChoice(
      inbox,
      leader,
      "choice_decided",
      result.choice,
      undefined,
      detail,
    );
  return result;
}
