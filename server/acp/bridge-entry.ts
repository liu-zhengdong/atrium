import { existsSync } from "node:fs";
import { join } from "node:path";
import { useDist } from "../entry.ts";
import { packageRoot } from "../service-state.ts";

/**
 * 桥进程用哪份代码（#418），与服务进程同一规则（server/entry.ts）：装好的包跑发版时编译的 dist/acp-bridge.js，
 * 仓库里用 tsx 跑源码。返回 node 的参数（不含 node 本身）；每次派活现查磁盘，update 换包后照样找得到。
 */
export function bridgeEntryArgs(root = packageRoot): string[] {
  const dist = join(root, "dist", "acp-bridge.js");
  if (
    useDist({
      dist: existsSync(dist),
      git: existsSync(join(root, ".git")),
      forced: process.env.ATRIUM_DIST === "1",
    })
  )
    return [dist];
  return [
    "--import",
    import.meta.resolve("tsx"),
    join(root, "server", "acp", "bridge-main.ts"),
  ];
}
