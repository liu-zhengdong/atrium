// 命令行与 supervisor 加载哪份代码（t117）：装好的包带发版时编译的 dist/，直接 import，
// 不在每次启动时现场编译 TypeScript；仓库里（有 .git）照旧用 tsx 跑源码，
// ATRIUM_DIST=1 时仓库里也用 dist（量启动耗时用）。服务进程由 server/entry.ts 按同一规则拉起。
import { existsSync } from "node:fs";
import { enableCompileCache } from "node:module";

const root = new URL("../", import.meta.url);
const sources = { cli: "cli/main.ts", supervisor: "server/supervisor.ts" };

export function useDist(name) {
  return (
    existsSync(new URL(`dist/${name}.js`, root)) &&
    (process.env.ATRIUM_DIST === "1" || !existsSync(new URL(".git", root)))
  );
}

export async function load(name) {
  if (useDist(name)) {
    // V8 编译缓存（默认在系统临时目录）：省掉每次启动重新编译 dist 的时间。
    enableCompileCache?.();
    return import(new URL(`dist/${name}.js`, root).href);
  }
  let register;
  try {
    ({ register } = await import("tsx/esm/api"));
  } catch {
    throw new Error(
      `Atrium 安装包缺少编译产物 dist/${name}.js；请重新安装（仓库里先 npm run dist 再打包）`,
    );
  }
  register();
  return import(new URL(sources[name], root).href);
}
