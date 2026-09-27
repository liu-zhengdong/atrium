import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { packageRoot } from "./service-state.ts";

/**
 * 拉起服务进程用哪份代码（t117）。与 bin/entry.mjs 同一规则：
 * 包里有发版时编译的 dist/ 就直接跑它（不带 tsx，没有常驻的 esbuild 子进程）；
 * 仓库里（有 .git）照旧用 tsx 跑源码，ATRIUM_DIST=1 时仓库里也用 dist。
 * 回滚到没有 dist/ 的旧版本时同样退回 tsx——那些版本把 tsx 装在运行依赖里。
 * 每次拉起时现查磁盘：supervisor 可能刚把包换成另一个版本。
 */
export type EntryFacts = { dist: boolean; git: boolean; forced: boolean };

export function useDist({ dist, git, forced }: EntryFacts): boolean {
  return dist && (forced || !git);
}

/** node 的参数：entry 是测试替换的入口脚本（相对包根或绝对路径，TypeScript 源码）。 */
export function serviceArgs(entry?: string, root = packageRoot): string[] {
  if (entry === undefined) {
    const dist = join(root, "dist", "server.js");
    if (
      useDist({
        dist: existsSync(dist),
        git: existsSync(join(root, ".git")),
        forced: process.env.ATRIUM_DIST === "1",
      })
    )
      return [dist];
  }
  return [
    "--import",
    import.meta.resolve("tsx"),
    resolve(root, entry ?? "server/main.ts"),
  ];
}
