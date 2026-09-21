import { useState, type KeyboardEvent } from "react";
import {
  MENTION_ALL,
  mentionsAll,
  resolveMentions,
} from "../../shared/mentions.ts";
import type { Agent } from "../components/AgentAvatar.tsx";

export type AllOption = { kind: "all"; name: string; alias: string };
export type Candidate = AllOption | Agent;
export const isAllOption = (item: Candidate): item is AllOption =>
  "kind" in item && item.kind === "all";
const ALL_OPTION: AllOption = {
  kind: "all",
  name: MENTION_ALL,
  alias: "所有人",
};

/** @ 候选与键盘选择；@ 全体只在群聊里出现，且只有用户能用。 */
export function useMentionPicker({
  draft,
  isGroup,
  agents,
  replace,
}: {
  draft: string;
  isGroup: boolean;
  agents: Agent[];
  replace: (text: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const [hidden, setHidden] = useState(false);
  const query = draft.match(/(?:^|\s)@([^@\n]*)$/)?.[1];
  const pool: Candidate[] = isGroup ? [ALL_OPTION, ...agents] : agents;
  const candidates =
    !hidden && query !== undefined
      ? pool
          .filter((item) => {
            const needle = query.toLowerCase();
            return (
              item.name.toLowerCase().includes(needle) ||
              (isAllOption(item) && item.alias.includes(needle))
            );
          })
          .slice(0, 6)
      : [];
  function reset() {
    setHidden(false);
    setIndex(0);
  }
  function choose(item: Candidate) {
    replace(draft.replace(/@[^@\n]*$/, `@${item.name} `));
    setHidden(true);
    setIndex(0);
  }
  /** 返回 true 表示这次按键已经被候选列表消费。 */
  function handleKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      setHidden(true);
      return true;
    }
    if (!candidates.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setIndex((i) => (i + step + candidates.length) % candidates.length);
      return true;
    }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
      event.preventDefault();
      choose(candidates[index] ?? candidates[0]!);
      return true;
    }
    return false;
  }
  return {
    candidates,
    index,
    choose,
    reset,
    handleKey,
    mentionIds: resolveMentions(draft, agents),
    mentionAll: isGroup && mentionsAll(draft),
  };
}
