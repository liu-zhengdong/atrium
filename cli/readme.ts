import type { Command } from "./main.ts";
import { groups, referenceEntry } from "./guide.ts";

/**
 * README 的「命令参考」段：和 `atrium --help`、`atrium guide` 一样从命令表生成，
 * `npm run docs` 写回，`npm run docs:check` 核对。只被脚本与测试引入，不进命令行启动路径。
 */
export const begin =
  "<!-- 命令参考开始：由命令表生成，改命令后跑 npm run docs，不要手改这一段 -->";
export const end = "<!-- 命令参考结束 -->";

/**
 * 生成段正文（不含起止标记）。按 `groups` 的分组与组内顺序排，没归组的（旧写法别名）放最后；
 * 不含时间、版本等会变的内容，同一份命令表永远生成同一段文字。
 * 服务组里 `atrium`、`status`、`stop` 不在命令表（启动路径单独处理），用法与说明取 `service`。
 */
export function reference(
  commands: Record<string, Command>,
  service: [usage: string, about: string][],
): string {
  const bare = new Map(service.map(([usage, about]) => [usage, about]));
  const entry = (name: string) => {
    const command = commands[name];
    if (command) return referenceEntry(name, command);
    const about = bare.get(`atrium ${name}`.trimEnd());
    return about === undefined
      ? undefined
      : `atrium ${name}`.trimEnd() + `\n  ${about}`;
  };
  const grouped = new Set(Object.values(groups).flat());
  const sections: [string, string[]][] = [
    ...Object.entries(groups).map(([group, members]): [string, string[]] => [
      group,
      group === "服务" ? ["", ...members] : members,
    ]),
    ["其他", Object.keys(commands).filter((name) => !grouped.has(name))],
  ];
  return sections
    .map(
      ([group, members]) =>
        [group, members.flatMap((name) => entry(name) ?? [])] as const,
    )
    .filter(([, entries]) => entries.length)
    .map(
      ([group, entries]) =>
        `### ${group}\n\n\`\`\`text\n${entries.join("\n\n")}\n\`\`\``,
    )
    .join("\n\n");
}

/** 把 README 里起止标记之间换成新生成的段；标记缺失、重复或顺序颠倒时报错，不猜位置。 */
export function withReference(readme: string, section: string): string {
  const eol = readme.includes("\r\n") ? "\r\n" : "\n";
  const text = readme.replaceAll("\r\n", "\n");
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (
    start < 0 ||
    stop < 0 ||
    stop < start ||
    text.indexOf(begin, start + 1) >= 0 ||
    text.indexOf(end, stop + 1) >= 0
  )
    throw new Error(
      `README.md 里要各有一行起止标记，且开始在前：\n${begin}\n${end}`,
    );
  const next = `${text.slice(0, start)}${begin}\n\n${section}\n\n${text.slice(stop)}`;
  return eol === "\n" ? next : next.replaceAll("\n", eol);
}
