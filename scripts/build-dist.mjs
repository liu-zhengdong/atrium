#!/usr/bin/env node
// 发版时把 cli/、server/、shared/ 编译成 dist/ 下的 JS（t117）：装好的包直接加载，
// 不在每次启动时用 tsx 现场编译。第三方包不打进来，照旧从 node_modules 加载。
//
// - dist/cli.js：命令行入口，按 import() 拆块，读命令不加载服务端大模块；
// - dist/server.js、dist/supervisor.js：服务与重启 supervisor，各自一个完整文件、不拆块——
//   长跑进程在 update 换掉磁盘上的包之后仍可能执行到延迟加载的代码，拆块会找不到旧块。
//
// 所有产物平铺在 dist/ 下：源码里 `new URL("../", import.meta.url)` 取包根目录，
// 编译后同样指向包根。
//
// 发版标签的提交里已带着编译好的 dist/（发版流程提交），从标签装（atrium update、README 的
// 安装步骤）时 clone 下来没有 node_modules：--prepack（npm pack 前自动跑）在没有 esbuild、
// dist/ 又齐全时沿用它，不报错。
//
// 提示一律写 stderr：atrium update 用 `npm pack --json` 并解析 stdout，prepack 的输出混进去
// 会让（包括旧版本的）更新失败。
//
//   node scripts/build-dist.mjs [--outdir <目录>] [--prepack]
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    outdir: { type: "string", default: join(root, "dist") },
    prepack: { type: "boolean", default: false },
  },
});
const outdir = resolve(values.outdir);

const entries = ["cli", "server", "supervisor"];
let build;
try {
  ({ build } = await import("esbuild"));
} catch {
  if (
    values.prepack &&
    entries.every((name) => existsSync(join(outdir, `${name}.js`)))
  ) {
    console.error(`没有 esbuild，沿用已编译的 ${outdir}`);
    process.exit(0);
  }
  console.error("没有 esbuild：先在仓库里运行 npm ci");
  process.exit(1);
}

const common = {
  absWorkingDir: root,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  packages: "external",
  outdir,
  entryNames: "[name]",
  chunkNames: "chunk-[hash]",
  legalComments: "none",
  logLevel: "warning",
};

rmSync(outdir, { recursive: true, force: true });
await build({
  ...common,
  entryPoints: { cli: "cli/main.ts" },
  splitting: true,
});
await build({
  ...common,
  entryPoints: { server: "server/main.ts", supervisor: "server/supervisor.ts" },
  splitting: false,
});
console.error(`已编译到 ${outdir}`);
