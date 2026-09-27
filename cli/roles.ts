import { readFileSync, statSync } from "node:fs";
import { Problem } from "../server/problem.ts";
import type { JobRole } from "../server/tasks/job-roles.ts";
import { recordNext } from "./contract.ts";
import { printJson, table } from "./format.ts";
import type { Command, Values } from "./main.ts";
const str = (v: Values, k: string) =>
  typeof v[k] === "string" ? (v[k] as string) : undefined;
const client = async () => (await import("./service.ts")).connect();
const path = (s: string) => encodeURIComponent(s);
const bodyFile = (file: string) => {
  try {
    if (!statSync(file).isFile()) throw new Error("not file");
    return readFileSync(file, "utf8");
  } catch {
    throw new Problem(400, `--body 文件读不到：${file}`, "usage");
  }
};
const fields = (v: Values) => ({
  ...(str(v, "name") === undefined ? {} : { name: str(v, "name") }),
  ...(str(v, "description") === undefined
    ? {}
    : { description: str(v, "description") }),
  ...(str(v, "body") === undefined ? {} : { body: bodyFile(str(v, "body")!) }),
  ...(str(v, "preferred") === undefined
    ? {}
    : { preferred: str(v, "preferred")!.split(",").filter(Boolean) }),
  ...(str(v, "checks") === undefined
    ? {}
    : { checks: str(v, "checks")!.split(",").filter(Boolean) }),
  ...(str(v, "skills") === undefined
    ? {}
    : { skills: str(v, "skills")!.split(",").filter(Boolean) }),
  ...(str(v, "as") === undefined ? {} : { author: str(v, "as") }),
});
const opts = {
  name: { type: "string" as const },
  description: { type: "string" as const },
  body: { type: "string" as const },
  preferred: { type: "string" as const },
  checks: { type: "string" as const },
  skills: { type: "string" as const },
  as: { type: "string" as const },
};
const output = (
  json: boolean,
  value: unknown,
  message: string,
  next: string,
) => {
  if (json) printJson(value);
  else console.log(message);
  recordNext(next);
};
export const roleCommands: Record<string, Command> = {
  "role ls": {
    args: "[--json]",
    about: "列出组织级角色",
    positionals: [0, 0],
    async run({ json }) {
      const rows = await (await client()).get<JobRole[]>("/roles");
      output(
        json,
        rows,
        table([
          ["短号", "名称", "做什么", "在做"],
          ...rows.map((r) => [
            r.ref,
            r.name,
            r.description,
            String(r.running ?? 0),
          ]),
        ]),
        "看角色：atrium role show r1",
      );
    },
  },
  "role show": {
    args: "角色 [--json]",
    about: "查看角色、岗位说明、优先执行者、交付关卡与技能",
    positionals: [1, 1],
    async run({ positionals: [id], json }) {
      const role = await (await client()).get<JobRole>(`/roles/${path(id!)}`);
      output(
        json,
        role,
        `${role.ref} ${role.name} · r${role.rev}\n${role.description}\n优先执行者：${role.preferred.join("、") || "无"}\n交付关卡：${role.checks.join("、") || "无"}\n技能：${role.skills.join("、") || "无"}\n\n${role.body}`,
        `建任务：atrium task add 标题 --job ${role.ref}`,
      );
    },
  },
  "role add": {
    args: "名称 --description 文字 --body 文件 [--preferred 列表] [--checks 列表] [--skills 列表]",
    about: "创建组织级角色；列表用逗号分隔，正文从文件读取",
    options: opts,
    positionals: [1, 1],
    async run({ positionals: [name], values, json }) {
      if (!str(values, "description") || !str(values, "body"))
        throw new Problem(400, "--description 和 --body 必填", "usage");
      const role = await (
        await client()
      ).post<JobRole>("/roles", { ...fields(values), name });
      output(
        json,
        role,
        `已建 ${role.ref} ${role.name}`,
        `看角色：atrium role show ${role.ref}`,
      );
    },
  },
  "role edit": {
    args: "角色 [--name 名称] [--description 文字] [--body 文件] [--preferred 列表] [--checks 列表] [--skills 列表]",
    about: "修订角色，保留历史",
    options: opts,
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const body = fields(values);
      if (!Object.keys(body).some((k) => k !== "author"))
        throw new Problem(400, "至少提供一项要修改的角色字段", "usage");
      const role = await (
        await client()
      ).patch<JobRole>(`/roles/${path(id!)}`, body);
      output(
        json,
        role,
        `已修订 ${role.ref} ${role.name} · r${role.rev}`,
        `看角色：atrium role show ${role.ref}`,
      );
    },
  },
};
