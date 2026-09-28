/**
 * 一条 shell 命令的人话概括（看板「最近动作」用）：常见命令映射成动作（`npm run check` →
 * 「跑完整检查」、`git push` →「推送」、`gh pr create` →「开 PR」），读写文件只写文件名，
 * 其余只给命令名（「跑 python3 脚本」「跑 mkdir」）。不显示参数、管道后段与 heredoc 内容。纯函数。
 */

/** 一段简单命令：拆好的词、是否带 heredoc 或内联脚本（-c / -e / -）、是不是管道的后段。 */
type Segment = { words: string[]; heredoc: boolean; piped: boolean };

/**
 * 按 shell 的引号规则把命令拆成段：未加引号的 `&&`、`||`、`;`、`|`、`&` 与换行是分隔；
 * `<<` 之后的 heredoc 正文整段跳过。不求完整，只求不把引号里的 `|`、`;` 当成分隔。
 */
function segmentsOf(command: string): Segment[] {
  const segments: Segment[] = [];
  let words: string[] = [];
  let word = "";
  let quoted = false;
  let heredoc = false;
  let piped = false;
  let pending: string | undefined;
  const endWord = () => {
    if (word || quoted) words.push(word);
    word = "";
    quoted = false;
  };
  const endSegment = (nextPiped: boolean) => {
    endWord();
    if (words.length) segments.push({ words, heredoc, piped });
    words = [];
    heredoc = false;
    piped = nextPiped;
  };
  const text = command;
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === "'" || char === '"') {
      const close = text.indexOf(char, i + 1);
      const end = close < 0 ? text.length : close;
      word += text.slice(i + 1, end);
      quoted = true;
      i = end + 1;
      continue;
    }
    if (char === "\\" && text[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (char === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
      endWord();
      const match = /^<<-?\s*(['"]?)([\w.-]+)\1/.exec(text.slice(i));
      if (match) {
        pending = match[2];
        heredoc = true;
        i += match[0].length;
        continue;
      }
    }
    if (char === "\n") {
      endSegment(false);
      i++;
      if (pending) {
        // heredoc 正文到只有结束符的那一行为止。
        const lines = text.slice(i).split("\n");
        let skipped = 0;
        for (const line of lines) {
          skipped += line.length + 1;
          if (line.trim() === pending) break;
        }
        i += skipped;
        pending = undefined;
      }
      continue;
    }
    if (char === ";" || char === "&" || char === "|") {
      const pair = text[i + 1] === char;
      const pipe = char === "|" && !pair;
      // 2>&1、>&2 这类重定向不是分隔。
      if (char === "&" && (text[i - 1] === ">" || text[i + 1] === ">")) {
        word += char;
        i++;
        continue;
      }
      endSegment(pipe);
      i += pair ? 2 : 1;
      continue;
    }
    if (char === " " || char === "\t") {
      endWord();
      i++;
      continue;
    }
    word += char;
    i++;
  }
  endSegment(false);
  return segments;
}

/** 只做流程控制、不算动作的词；段首是它们就跳过（`do`、`then` 后面才是真命令）。 */
const LEADING = new Set([
  "do",
  "then",
  "else",
  "if",
  "while",
  "until",
  "!",
  "{",
  "(",
  "time",
  "sudo",
  "exec",
  "command",
  "env",
]);
/** 整段不算动作。 */
const NOISE = new Set([
  "cd",
  "pushd",
  "popd",
  "echo",
  "printf",
  "export",
  "set",
  "unset",
  "true",
  "false",
  ":",
  "for",
  "done",
  "fi",
  "esac",
  "}",
  ")",
  "sleep",
  "wait",
  "source",
  ".",
  "local",
  "read",
]);

/** 去掉段首的变量赋值（FOO=1）、流程关键字、timeout N 与路径前缀，留下真正的命令词。 */
function commandWords(words: string[]) {
  let rest = words;
  for (;;) {
    const head = rest[0];
    if (head === undefined) return rest;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || LEADING.has(head)) {
      rest = rest.slice(1);
      continue;
    }
    if (head === "timeout" || head === "nice") {
      rest = rest
        .slice(1)
        .filter((word, index) => index > 0 || !/^-?\d/.test(word));
      continue;
    }
    return rest;
  }
}

const base = (path: string) =>
  path.replace(/\/+$/, "").split("/").pop() || path;
const name = (word: string) => base(word);
/** 第一个像文件的参数（不是选项、不是 sed 脚本）。 */
const fileArg = (args: string[]) =>
  args.find(
    (arg) =>
      !arg.startsWith("-") &&
      /[\w.]/.test(arg) &&
      !/^\d+(,\d+)?p$/.test(arg) &&
      !arg.includes("*"),
  );

const SCRIPT_TOOLS = new Set([
  "python",
  "python3",
  "node",
  "bash",
  "sh",
  "zsh",
  "ruby",
  "perl",
  "deno",
  "bun",
  "tsx",
]);

const NPM_SCRIPTS: Record<string, string> = {
  check: "跑完整检查",
  test: "跑测试",
  "format:check": "查格式",
  format: "排版",
  build: "构建",
  lint: "跑静态检查",
  typecheck: "类型检查",
};

const GIT: Record<string, string> = {
  push: "推送",
  commit: "提交",
  add: "暂存改动",
  status: "看改动",
  diff: "看改动",
  log: "看提交记录",
  show: "看提交",
  rebase: "变基",
  fetch: "拉取远端",
  pull: "拉取最新代码",
  checkout: "切分支",
  switch: "切分支",
  branch: "看分支",
  merge: "合并分支",
  worktree: "管理 worktree",
  reset: "回退改动",
  restore: "撤销改动",
  "rev-parse": "查版本号",
  "ls-files": "列文件",
  blame: "查改动来源",
  grep: "搜代码",
  clone: "克隆仓库",
  tag: "打标签",
  config: "看 git 配置",
};

const GH_PR: Record<string, string> = {
  create: "开 PR",
  checks: "看 CI",
  view: "看 PR",
  diff: "看 PR 改动",
  comment: "评论 PR",
  edit: "改 PR",
  list: "列 PR",
  merge: "合入 PR",
  review: "审 PR",
  ready: "PR 转为待审",
  status: "看 PR 状态",
};

const GH_ISSUE: Record<string, string> = {
  view: "看 issue",
  create: "开 issue",
  comment: "评论 issue",
  list: "列 issue",
  edit: "改 issue",
  close: "关 issue",
};

/** 准备性质的动作：同一条命令里另有实在动作时让位。 */
const WEAK = new Set(["建目录", "建文件", "列文件", "复制文件"]);

/** 一段命令的人话；undefined 表示不认识，交给上层只给命令名。 */
function gistOf(segment: Segment): string | undefined {
  const words = commandWords(segment.words);
  const head = words[0];
  if (!head) return undefined;
  const cmd = name(head);
  const args = words.slice(1);
  const sub = args.find((arg) => !arg.startsWith("-"));
  switch (cmd) {
    case "npm":
    case "pnpm":
    case "yarn": {
      const script =
        sub === "run" || sub === "run-script"
          ? args[args.indexOf(sub) + 1]
          : sub;
      if (sub === "test" || sub === "t") return "跑测试";
      if (sub === "install" || sub === "i" || sub === "ci" || sub === "add")
        return "装依赖";
      if (script && NPM_SCRIPTS[script]) return NPM_SCRIPTS[script];
      return script ? `跑 ${cmd} ${script}` : `跑 ${cmd}`;
    }
    case "npx":
      if (sub === "tsc") return "类型检查";
      if (sub === "prettier")
        return args.includes("--check") ? "查格式" : "排版";
      return sub ? `跑 ${name(sub)}` : "跑 npx";
    case "tsc":
      return "类型检查";
    case "prettier":
      return args.includes("--check") ? "查格式" : "排版";
    case "git": {
      // git -C <目录> <子命令>
      const rest = args[0] === "-C" ? args.slice(2) : args;
      const verb = rest.find((arg) => !arg.startsWith("-"));
      return (verb && GIT[verb]) ?? "跑 git";
    }
    case "gh": {
      const rest = args.filter(
        (arg, index) =>
          !arg.startsWith("-") &&
          !(index > 0 && ["-R", "--repo"].includes(args[index - 1]!)),
      );
      const [group, verb] = rest;
      if (group === "pr") return (verb && GH_PR[verb]) ?? "看 PR";
      if (group === "issue") return (verb && GH_ISSUE[verb]) ?? "看 issue";
      if (group === "run") return "看 CI";
      if (group === "api") return "查 GitHub";
      if (group === "repo") return "看仓库";
      return "跑 gh";
    }
    case "atrium": {
      const verb = args.find((arg) => !arg.startsWith("-"));
      return verb ? `跑 atrium ${verb}` : "跑 atrium";
    }
    case "rg":
    case "grep":
    case "ag":
      return "搜代码";
    case "ls":
    case "find":
    case "tree":
    case "fd":
      return "列文件";
    case "cat":
    case "head":
    case "tail":
    case "less":
    case "nl":
    case "wc":
    case "sed":
    case "awk":
    case "jq": {
      // cat > 文件 <<EOF 是写文件；tail 源文件 > 目标 只是搬内容。
      const redirect = words.findIndex((word) => word === ">" || word === ">>");
      const glued = words.find((word) => /^>>?[^>&]/.test(word));
      const target =
        redirect >= 0 ? words[redirect + 1] : glued?.replace(/^>+/, "");
      if (target) return segment.heredoc ? `写 ${base(target)}` : "复制文件";
      if (
        (cmd === "sed" && args.includes("-i")) ||
        cmd === "awk" ||
        cmd === "jq"
      ) {
        const file = fileArg(args.slice(1));
        return cmd === "sed" && args.includes("-i")
          ? `改 ${file ? base(file) : "文件"}`
          : `跑 ${cmd}`;
      }
      const file = fileArg(
        cmd === "sed" ? args.filter((arg) => arg !== "-n").slice(1) : args,
      );
      return file ? `读 ${base(file)}` : `读文件`;
    }
    case "mkdir":
      return "建目录";
    case "rm":
      return "删文件";
    case "mv":
    case "cp":
      return "挪文件";
    case "touch":
      return "建文件";
    case "curl":
    case "wget":
      return "请求接口";
    case "kill":
    case "pkill":
      return "停进程";
    case "ps":
    case "lsof":
    case "pgrep":
      return "看进程";
    case "open":
      return "打开页面";
  }
  if (SCRIPT_TOOLS.has(cmd)) {
    if (sub === "--test" || args.includes("--test")) return "跑测试";
    // node bin/atrium.mjs <子命令>
    const script = args.find((arg) => !arg.startsWith("-"));
    if (script && /atrium\.mjs$/.test(script)) {
      const verb = args
        .slice(args.indexOf(script) + 1)
        .find((arg) => !arg.startsWith("-"));
      return verb ? `跑 atrium ${verb}` : "跑 atrium";
    }
    if (
      segment.heredoc ||
      args.some((arg) => ["-", "-c", "-e", "--eval", "-p"].includes(arg)) ||
      !script
    )
      return `跑 ${cmd} 脚本`;
    return `跑 ${base(script)}`;
  }
  return undefined;
}

/**
 * 命令的人话概括：从前往后找第一段认识的命令（管道后段只是加工输出，不算）；
 * 建目录、列文件这类准备动作排在后面，同一条里有更实在的动作就用它。
 * 都不认识就给第一段真正命令的名字；什么也没有就「跑命令」。
 */
export function commandGist(command: string): string {
  const segments = segmentsOf(command).filter((segment) => !segment.piped);
  const real = segments.filter((segment) => {
    const head = commandWords(segment.words)[0];
    return head !== undefined && !NOISE.has(head);
  });
  const gists = real.map(gistOf);
  const gist =
    gists.find((text) => text && !WEAK.has(text)) ?? gists.find(Boolean);
  if (gist) return gist;
  const head = real[0] && commandWords(real[0].words)[0];
  if (head) return `跑 ${name(head)}`;
  const any = segments[0] && commandWords(segments[0].words)[0];
  if (any === "sleep") return "等待";
  return any ? `跑 ${name(any)}` : "跑命令";
}
