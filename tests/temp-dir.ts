import { rmSync } from "node:fs";
import { after } from "node:test";
import { killProcessesUnder } from "./win-processes.ts";

/**
 * 删测试临时目录，三平台通用。
 *
 * t.after 按登记顺序执行，很多用例先登记删目录、后登记关服务：Unix 上删得掉已打开的文件，
 * Windows 上数据库与日志还开着、或假执行者（按设计不随服务退出）还以它为工作目录时删不掉
 * （EPERM/EBUSY）。删不掉的先记下，整个测试文件结束时（服务都已关闭）先结束命令行指向该目录
 * 的进程，再带重试删一次。
 */
const deferred = new Set<string>();

// 模块加载时登记在文件级（根测试）上：用例进行中调用 after 会挂到当前用例上。
// 服务关闭时发出的结束进程树是异步的，机器忙时可能还没结束完：删不掉就再找一轮进程、再删，最多三轮。
after(() => {
  for (const dir of deferred)
    for (let round = 1; ; round++) {
      killProcessesUnder(dir);
      try {
        rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 100,
        });
        break;
      } catch (error) {
        if (round >= 3) throw error;
      }
    }
});

export function removeTemp(path: string) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY"))
      throw error;
    deferred.add(path);
  }
}
