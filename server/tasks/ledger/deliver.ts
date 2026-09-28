import { usage } from "./ledger-model.ts";

export const DELIVERS = ["pr", "comment", "none"] as const;
export type Deliver = (typeof DELIVERS)[number];

export function deliverOf(value: unknown): Deliver {
  if (typeof value !== "string" || !DELIVERS.includes(value as Deliver))
    throw usage(`deliver: 只能是 ${DELIVERS.join("、")}`);
  return value as Deliver;
}

export function issueOf(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9][0-9]*$/.test(text))
    throw usage("issue: 应为正整数 issue 号");
  const issue = Number(text);
  if (!Number.isSafeInteger(issue)) throw usage("issue: 应为正整数 issue 号");
  return issue;
}

export function validateDeliver(deliver: Deliver, issue: number | null) {
  if (deliver === "comment" && issue === null)
    throw usage("--deliver comment 需同时给 --issue <号>");
}
