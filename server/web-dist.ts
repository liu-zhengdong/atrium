import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT_FILES = [
  "index.html",
  "vite.config.ts",
  "package.json",
  "package-lock.json",
] as const;
const ROOT_DIRS = ["web", "shared"] as const;
export const WEB_STAMP = ".source-hash";

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

function relFiles(root: string, dir: string): string[] {
  return filesIn(dir)
    .map((path) => relative(root, path).split(sep).join("/"))
    .sort();
}

function sourceFiles(root: string): string[] {
  const files: string[] = ROOT_FILES.filter((name) =>
    existsSync(join(root, name)),
  );
  for (const dir of ROOT_DIRS) files.push(...relFiles(root, join(root, dir)));
  return files.sort();
}

function hashFiles(root: string, files: string[]): string {
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function stampPath(root: string) {
  return join(root, "dist", WEB_STAMP);
}

function readStamp(root: string) {
  const text = readFileSync(stampPath(root), "utf8");
  const source = /^source ([0-9a-f]{64})$/m.exec(text)?.[1];
  const dist = /^dist ([0-9a-f]{64})$/m.exec(text)?.[1];
  if (!source || !dist) throw new Error("Web 产物指纹损坏");
  return { source, dist };
}

// 指纹同时绑定源码内容和产物内容：构建后 git restore dist 只回退产物，
// 内容对不上指纹就重新构建，不看 mtime（回退会把 mtime 刷成最新）。
export function stampWebDist(root: string) {
  const distIndex = join(root, "dist/index.html");
  if (!existsSync(distIndex)) throw new Error(`Web 构建后仍缺少 ${distIndex}`);
  mkdirSync(join(root, "dist"), { recursive: true });
  const stamp = `source ${hashFiles(root, sourceFiles(root))}\ndist ${hashFiles(root, relFiles(root, join(root, "dist")))}\n`;
  writeFileSync(stampPath(root), stamp);
}

export function webDistStale(root: string): boolean {
  const distIndex = join(root, "dist/index.html");
  if (!existsSync(distIndex)) return true;
  // Tagged installations ship prebuilt assets without Vite source or dev deps.
  if (!existsSync(join(root, "web"))) return false;
  try {
    const stamp = readStamp(root);
    return (
      stamp.source !== hashFiles(root, sourceFiles(root)) ||
      stamp.dist !== hashFiles(root, relFiles(root, join(root, "dist")))
    );
  } catch {
    // 没有指纹、指纹损坏或源码读取失败时按过期处理，宁可多构建一次。
    return true;
  }
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
      stampWebDist(root);
    } catch (error) {
      // 构建失败时 vite 可能已经写出 index.html 和指纹。
      // 留着它们会让下次启动判定 dist 是最新的，把一份不完整的产物发给浏览器，整页白屏。
      rmSync(join(root, "dist/index.html"), { force: true });
      rmSync(stampPath(root), { force: true });
      throw error;
    }
    built = true;
  });
  return built;
}
