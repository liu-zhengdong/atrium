// 适配器 worker：在独立线程中执行 Agent 自己编写的适配器。
// 每次推送新建 worker，模块缓存随 worker 销毁，适配器文件改动下次推送即生效。
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { dir, files, request, agent } = workerData;

const emitted = [];
const errors = [];

for (const file of files) {
  let count = 0;
  try {
    const module = await import(pathToFileURL(join(dir, file)).href);
    const handler = module.default;
    if (typeof handler !== "function") {
      errors.push(`${file}: 缺少默认导出的处理函数`);
      continue;
    }
    await handler({
      request,
      agent,
      emit(message) {
        if (count >= 20 || !message || typeof message !== "object") return;
        count += 1;
        emitted.push({ file, message });
      },
      log(...args) {
        console.log(`[adapter ${file}]`, ...args);
      },
    });
  } catch (error) {
    errors.push(
      `${file}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

parentPort.postMessage({ emitted, errors });
