import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  addEvent,
  atomically,
  parseTaskRef,
  requireRow,
  taskRef,
  view,
  type Task,
  type TaskRow,
  usage,
} from "./ledger-model.ts";
import {
  objectOf,
  onlyKeys,
  optionalText,
  ownerOf,
  parentOf,
  repoOf,
  statusOf,
  title,
} from "./ledger-validate.ts";
import { applyTransition } from "./ledger-transition.ts";
import { setConditions } from "./schedule-ledger.ts";
import { noteView } from "./notes.ts";
import {
  deliverOf,
  issueOf,
  validateDeliver,
  type Deliver,
} from "./deliver.ts";

export type NewTask = {
  title: string;
  parent?: string | number | null;
  role?: string | null;
  repo?: string | null;
  brief_path?: string | null;
  owner?: string | null;
  deliver?: Deliver;
  issue?: number;
  after?: string;
  after_pr?: string;
  auto?: boolean;
};

export function createTask(
  db: DatabaseSync,
  body: unknown,
  now = Date.now(),
): Task {
  const input = objectOf(body);
  onlyKeys(input, [
    "title",
    "parent",
    "role",
    "repo",
    "brief_path",
    "owner",
    "deliver",
    "issue",
    "after",
    "after_pr",
    "auto",
  ]);
  const deliver = input.deliver === undefined ? "pr" : deliverOf(input.deliver);
  const issue = issueOf(input.issue);
  validateDeliver(deliver, issue);
  const values = {
    owner:
      input.owner === undefined || input.owner === null || input.owner === ""
        ? null
        : ownerOf(input.owner),
    title: title(input.title),
    role: optionalText(input.role, "role", 200),
    repo: repoOf(input.repo),
    brief_path: optionalText(input.brief_path, "brief_path"),
  };
  return atomically(db, () => {
    const parent = parentOf(db, input.parent);
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO tasks(parent_id,title,brief_path,role,repo,owner,deliver,issue,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'todo',?,?)",
      )
      .run(
        parent,
        values.title,
        values.brief_path,
        values.role,
        values.repo,
        values.owner,
        deliver,
        issue,
        now,
        now,
      );
    const id = Number(lastInsertRowid);
    setConditions(db, id, input, now);
    addEvent(db, id, now, "created", {
      title: values.title,
      ...(parent ? { parent: taskRef(parent) } : {}),
    });
    const task = requireRow(db, id);
    return { ...view(task), ...noteView(db, id, task.status) };
  });
}

/** 人工修正：title / brief_path / role / status；status 经状态机的 manual_set。 */
export function updateTask(
  db: DatabaseSync,
  reference: unknown,
  body: unknown,
  now = Date.now(),
): Task {
  const id = parseTaskRef(reference);
  const input = objectOf(body);
  onlyKeys(input, [
    "title",
    "brief_path",
    "role",
    "status",
    "deliver",
    "issue",
    "after",
    "after_pr",
    "auto",
    "pr_url",
  ]);
  if (!Object.keys(input).length)
    throw usage(
      "至少修改一项：title、brief_path、role、status、deliver、issue、after、after_pr、auto、pr_url",
    );
  const fields: Record<string, string | number | null> = {};
  if ("title" in input) fields.title = title(input.title);
  if ("brief_path" in input)
    fields.brief_path = optionalText(input.brief_path, "brief_path");
  if ("role" in input) fields.role = optionalText(input.role, "role", 200);
  if ("deliver" in input) fields.deliver = deliverOf(input.deliver);
  if ("issue" in input) fields.issue = issueOf(input.issue);
  if ("pr_url" in input) {
    if (
      typeof input.pr_url !== "string" ||
      !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(
        input.pr_url,
      )
    )
      throw usage("pr_url: 应为 https://github.com/owner/repo/pull/N");
    fields.pr_url = input.pr_url;
  }
  const target = "status" in input ? statusOf(input.status) : undefined;
  return atomically(db, () => {
    const current = requireRow(db, id);
    if (fields.pr_url !== undefined && current.status === "running")
      throw new Problem(409, "执行中不能人工补登 PR", "conflict");
    setConditions(db, id, input, now);
    if (
      current.status === "running" &&
      ((fields.deliver !== undefined && fields.deliver !== current.deliver) ||
        (fields.issue !== undefined && fields.issue !== current.issue))
    )
      throw new Problem(409, "执行中不能修改交付物类型或 issue 号", "conflict");
    validateDeliver(
      (fields.deliver ?? current.deliver) as Deliver,
      (fields.issue === undefined ? current.issue : fields.issue) as
        number | null,
    );
    const changed = Object.fromEntries(
      Object.entries(fields).filter(
        ([key, value]) => current[key as keyof TaskRow] !== value,
      ),
    );
    if (changed.pr_url) changed.ci = "pending";
    if (Object.keys(changed).length) {
      db.prepare(
        `UPDATE tasks SET ${Object.keys(changed)
          .map((key) => `${key}=?`)
          .join(",")},updated_at=? WHERE id=?`,
      ).run(...Object.values(changed), now, id);
      addEvent(db, id, now, "edited", changed);
    }
    if (target !== undefined)
      applyTransition(db, current, { kind: "manual_set", to: target }, now);
    const task = requireRow(db, id);
    return { ...view(task), ...noteView(db, id, task.status) };
  });
}
