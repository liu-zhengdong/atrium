import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT_FILES = [
  "index.html",
  "vite.config.ts",
  "package.json",
  "package-lock.json",
] as const;
const ROOT_DIRS = ["web", "shared"] as const;

function filesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) files.push(...filesIn(path));
    else files.push(path);
  }
  return files;
}

export function webDistStale(root: string) {
  const distIndex = join(root, "dist/index.html");
  if (!existsSync(distIndex)) return true;
  const distTime = statSync(distIndex).mtimeMs;
  for (const name of ROOT_FILES) {
    const path = join(root, name);
    if (existsSync(path) && statSync(path).mtimeMs > distTime) return true;
  }
  for (const dir of ROOT_DIRS)
    for (const path of filesIn(join(root, dir)))
      if (statSync(path).mtimeMs > distTime) return true;
  return false;
}

async function withBuildLock(root: string, run: () => Promise<void>) {
  mkdirSync(join(root, "dist"), { recursive: true });
  const lock = join(root, "dist/.atrium-web-build.lock");
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 120000)
          rmSync(lock, { recursive: true, force: true });
      } catch {
        /* 锁已被其他进程清掉 */
      }
      await delay(100);
      continue;
    }
    try {
      await run();
      return;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  throw new Error("Web 构建等待超时");
}

async function buildWeb(root: string) {
  const { build } = await import("vite");
  await build({
    root,
    configFile: join(root, "vite.config.ts"),
    logLevel: "error",
  });
}

export async function ensureWebDist(
  root: string,
  build: (root: string) => Promise<void> = buildWeb,
) {
  if (!webDistStale(root)) return false;
  let built = false;
  await withBuildLock(root, async () => {
    if (!webDistStale(root)) return;
    console.log("Web 源码已更新，正在构建…");
    try {
      await build(root);
      if (!existsSync(join(root, "dist/index.html")))
        throw new Error(`Web 构建后仍缺少 ${join(root, "dist/index.html")}`);
    } catch (error) {
      // 构建失败时 vite 可能已经写出 index.html。
      // 留着它会让下次启动判定 dist 是最新的，把一份不完整的产物发给浏览器，整页白屏。
      rmSync(join(root, "dist/index.html"), { force: true });
      throw error;
    }
    built = true;
  });
  return built;
}
