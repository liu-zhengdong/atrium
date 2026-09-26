import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWebDist, WEB_STAMP, webDistStale } from "../server/web-dist.ts";

const old = new Date("2020-01-01T00:00:00Z");
const recent = new Date("2024-06-01T00:00:00Z");
const newer = new Date("2024-08-01T00:00:00Z");

function touch(path: string, at: Date, content = "x") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, at, at);
}

function repo(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "atrium-web-dist-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "web"));
  mkdirSync(join(root, "shared"));
  return root;
}

function build(root: string, indexContent = "<html>built</html>") {
  return ensureWebDist(root, async () => {
    touch(join(root, "dist/index.html"), recent, indexContent);
  });
}

test("没有 dist 或指纹范围内源码内容变了则需要构建", async (t) => {
  const root = repo(t);
  assert.equal(webDistStale(root), true);
  touch(join(root, "web/style.css"), old, "body{}");
  assert.equal(await build(root), true);
  assert.equal(webDistStale(root), false);
  touch(join(root, "server/main.ts"), newer, "x");
  assert.equal(webDistStale(root), false, "指纹范围外的文件不影响");
  touch(join(root, "web/style.css"), old, "body{color:red}");
  assert.equal(webDistStale(root), true, "内容变了即使 mtime 更旧也算过期");
});

test("构建后回退 dist（git restore dist）仍会重新构建", async (t) => {
  const root = repo(t);
  touch(join(root, "web/style.css"), old, "body{}");
  assert.equal(await build(root), true);
  assert.equal(webDistStale(root), false);
  // git restore dist：只回退产物、mtime 刷成最新，指纹还是构建时写下的
  touch(join(root, "dist/index.html"), new Date(), "<html>release</html>");
  assert.equal(webDistStale(root), true);
  assert.equal(await build(root), true);
  assert.equal(webDistStale(root), false);
});

test("源码变了且 dist 的 mtime 调到最新仍判定过期", async (t) => {
  const root = repo(t);
  touch(join(root, "web/style.css"), old, "body{}");
  assert.equal(await build(root), true);
  touch(join(root, "web/style.css"), newer, "body{color:red}");
  const future = new Date(Date.now() + 24 * 3600_000);
  utimesSync(join(root, "dist/index.html"), future, future);
  assert.equal(webDistStale(root), true);
});

test("没有指纹文件的 dist 判定过期", async (t) => {
  const root = repo(t);
  touch(join(root, "web/style.css"), old, "body{}");
  touch(join(root, "dist/index.html"), recent, "<html>release</html>");
  assert.equal(webDistStale(root), true, "旧产物没有指纹，先重建一次");
  assert.equal(await build(root), true);
  assert.equal(webDistStale(root), false);
});

test("构建配置与 shared 源码内容更新也会使 dist 过期", async (t) => {
  const root = repo(t);
  touch(join(root, "web/app.css"), old, "a");
  touch(join(root, "shared/mentions.ts"), old, "b");
  touch(join(root, "vite.config.ts"), old, "c");
  await build(root);
  assert.equal(webDistStale(root), false);
  touch(join(root, "vite.config.ts"), old, "c2");
  assert.equal(webDistStale(root), true);
  await build(root);
  touch(join(root, "shared/mentions.ts"), old, "b2");
  assert.equal(webDistStale(root), true);
  await build(root);
  touch(join(root, "package.json"), old, "{}");
  assert.equal(webDistStale(root), true, "新增被指纹覆盖的文件也算过期");
  await build(root);
  rmSync(join(root, "shared/mentions.ts"));
  assert.equal(webDistStale(root), true, "删除源文件也算过期");
});

test("安装版没有源码目录时不再检查", (t) => {
  const root = repo(t);
  touch(join(root, "dist/index.html"), recent, "<html>");
  rmSync(join(root, "web"), { recursive: true, force: true });
  rmSync(join(root, "shared"), { recursive: true, force: true });
  assert.equal(webDistStale(root), false);
  rmSync(join(root, "dist/index.html"));
  assert.equal(webDistStale(root), true, "缺产物仍要重建");
});

test("ensureWebDist 只在过期时构建，产物缺失则失败", async (t) => {
  const root = repo(t);
  touch(join(root, "web/style.css"), recent);
  let calls = 0;
  await assert.rejects(
    () =>
      ensureWebDist(root, async () => {
        calls += 1;
      }),
    /仍缺少/,
  );
  assert.equal(calls, 1);
  const built = await ensureWebDist(root, async () => {
    calls += 1;
    touch(join(root, "dist/index.html"), recent, "<html>");
  });
  assert.equal(built, true);
  assert.equal(calls, 2);
  assert.equal(
    existsSync(join(root, "dist", WEB_STAMP)),
    true,
    "构建成功留下指纹",
  );
  const skipped = await ensureWebDist(root, async () => {
    calls += 1;
  });
  assert.equal(skipped, false);
  assert.equal(calls, 2);
});

test("构建失败不留下指纹和会被当成最新的 dist", async (t) => {
  const root = repo(t);
  touch(join(root, "web/style.css"), recent);
  let calls = 0;
  const fail = async () => {
    calls += 1;
    // 模拟 vite：报错前已经写出了 index.html
    touch(join(root, "dist/index.html"), newer, "<html>");
    throw new Error("依赖没装好");
  };
  await assert.rejects(() => ensureWebDist(root, fail), /依赖没装好/);
  assert.equal(calls, 1);
  assert.equal(
    existsSync(join(root, "dist/index.html")),
    false,
    "失败的产物已清掉",
  );
  assert.equal(
    existsSync(join(root, "dist", WEB_STAMP)),
    false,
    "失败不留下指纹",
  );
  assert.equal(webDistStale(root), true, "下次启动仍判定过期");
  const built = await ensureWebDist(root, async () => {
    calls += 1;
    touch(join(root, "dist/index.html"), newer, "<html>");
  });
  assert.equal(calls, 2);
  assert.equal(built, true);
  // 源码更新后再次构建失败，也不能留下上一轮的指纹
  touch(join(root, "web/style.css"), newer, "y");
  await assert.rejects(() => ensureWebDist(root, fail), /依赖没装好/);
  assert.equal(calls, 3);
  assert.equal(
    existsSync(join(root, "dist", WEB_STAMP)),
    false,
    "失败后旧指纹也清掉",
  );
  assert.equal(webDistStale(root), true);
});

test("并发 ensureWebDist 只构建一次", async (t) => {
  const root = repo(t);
  touch(join(root, "web/style.css"), recent);
  let calls = 0;
  const run = () =>
    ensureWebDist(root, async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      touch(join(root, "dist/index.html"), recent, "<html>");
    });
  const results = await Promise.all([run(), run(), run()]);
  assert.equal(calls, 1);
  assert.equal(results.filter(Boolean).length, 1);
});
