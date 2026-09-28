import { Problem } from "../server/problem.ts";
import type { JobRole } from "../server/tasks/workers/job-roles.ts";
import { recordNext } from "./contract.ts";
import { printJson, table } from "./format.ts";
import type { Command, Values } from "./main.ts";
import { defaultActor } from "./worker-guard.ts";
const str = (v: Values, k: string) =>
  typeof v[k] === "string" ? (v[k] as string) : undefined;
const client = async () => (await import("./service.ts")).connect();
const path = (s: string) => encodeURIComponent(s);
const fields = (v: Values) => ({
  ...(str(v, "name") === undefined ? {} : { name: str(v, "name") }),
  ...(str(v, "description") === undefined
    ? {}
    : { description: str(v, "description") }),
  ...(str(v, "preferred") === undefined
    ? {}
    : { preferred: str(v, "preferred")!.split(",").filter(Boolean) }),
  ...(str(v, "checks") === undefined
    ? {}
    : { checks: str(v, "checks")!.split(",").filter(Boolean) }),
  ...(str(v, "skills") === undefined
    ? {}
    : { skills: str(v, "skills")!.split(",").filter(Boolean) }),
  ...((str(v, "as") ?? defaultActor()) === undefined
    ? {}
    : { author: str(v, "as") ?? defaultActor() }),
});
const opts = {
  name: { type: "string" as const },
  description: { type: "string" as const },
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
export const specialistCommands: Record<string, Command> = {
  "specialist ls": {
    args: "[专员] [--json]",
    about:
      "列出专员：名称、做什么、在做几件；给专员看这一位：做什么、优先执行者、交付关卡与技能",
    positionals: [0, 1],
    async run({ positionals: [id], json }) {
      if (id !== undefined) {
        const role = await (
          await client()
        ).get<JobRole>(`/specialists/${path(id)}`);
        output(
          json,
          role,
          `${role.ref} ${role.name} · r${role.rev}\n${role.description}\n优先执行者：${role.preferred.join("、") || "无"}\n交付关卡：${role.checks.join("、") || "无"}\n技能：${role.skills.join("、") || "无"}`,
          `建任务：atrium task add 标题 --by ${role.ref}`,
        );
        return;
      }
      const rows = await (await client()).get<JobRole[]>("/specialists");
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
        "看专员：atrium specialist ls r1",
      );
    },
  },
  "specialist add": {
    args: "名称 --description 文字 [--preferred 列表] [--checks 列表] [--skills 列表]",
    about:
      "创建专员（只记分工：一句做什么、优先执行者、验收关卡、挂哪些技能；做法写进技能，规矩写成要点）；列表用逗号分隔",
    options: opts,
    positionals: [1, 1],
    async run({ positionals: [name], values, json }) {
      if (!str(values, "description"))
        throw new Problem(
          400,
          "--description: 必填，一句话写这位专员做什么",
          "usage",
        );
      const role = await (
        await client()
      ).post<JobRole>("/specialists", { ...fields(values), name });
      output(
        json,
        role,
        `已建 ${role.ref} ${role.name}`,
        `看专员：atrium specialist ls ${role.ref}`,
      );
    },
  },
  "specialist edit": {
    args: "专员 [--name 名称] [--description 文字] [--preferred 列表] [--checks 列表] [--skills 列表]",
    about: "修订专员，保留历史",
    options: opts,
    positionals: [1, 1],
    async run({ positionals: [id], values, json }) {
      const body = fields(values);
      if (!Object.keys(body).some((k) => k !== "author"))
        throw new Problem(400, "至少提供一项要修改的专员字段", "usage");
      const role = await (
        await client()
      ).patch<JobRole>(`/specialists/${path(id!)}`, body);
      output(
        json,
        role,
        `已修订 ${role.ref} ${role.name} · r${role.rev}`,
        `看专员：atrium specialist ls ${role.ref}`,
      );
    },
  },
};
