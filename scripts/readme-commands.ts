// README「命令参考」段从命令表生成（cli/readme.ts）。
//
//   npm run docs          # 重新生成并写回 README.md
//   npm run docs:check    # 只核对，不一致时失败并提示跑 npm run docs（npm run check 会跑）
//
// 两个分支各加了命令、README 生成段冲突时：先解 cli/ 里的冲突，再跑 npm run docs 覆盖生成段。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commands, service } from "../cli/main.ts";
import { reference, withReference } from "../cli/readme.ts";

const path = fileURLToPath(new URL("../README.md", import.meta.url));
const current = readFileSync(path, "utf8");
const next = withReference(current, reference(commands, service));
if (process.argv.includes("--check")) {
  if (next !== current) {
    console.error(
      "README.md 的命令参考段和命令表不一致（改了命令没重新生成，或手改了生成段）。\n修正：npm run docs",
    );
    process.exitCode = 1;
  } else console.log("README.md 命令参考段与命令表一致");
} else if (next === current) console.log("README.md 命令参考段已是最新");
else {
  writeFileSync(path, next);
  console.log("已重新生成 README.md 命令参考段");
}
