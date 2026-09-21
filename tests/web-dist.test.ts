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
import { ensureWebDist, webDistStale } from "../server/web-dist.ts";

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

test("没有 dist 或源码更新则需要构建", (t) => {
  const root = repo(t);
  assert.equal(webDistStale(root), true);
  touch(join(root, "web/style.css"), old);
  touch(join(root, "dist/index.html"), recent);
  assert.equal(webDistStale(root), false);
  touch(join(root, "web/style.css"), newer);
  assert.equal(webDistStale(root), true);
  touch(join(root, "web/style.css"), old);
  touch(join(root, "dist/index.html"), recent);
  touch(join(root, "server/main.ts"), newer);
  assert.equal(webDistStale(root), false);
});

test("构建配置与 shared 源码更新也会使 dist 过期", (t) => {
  const root = repo(t);
  touch(join(root, "web/app.css"), old);
  touch(join(root, "shared/mentions.ts"), old);
  touch(join(root, "vite.config.ts"), old);
  touch(join(root, "dist/index.html"), recent);
  assert.equal(webDistStale(root), false);
  touch(join(root, "vite.config.ts"), newer);
  assert.equal(webDistStale(root), true);
  touch(join(root, "vite.config.ts"), old);
  touch(join(root, "dist/index.html"), recent);
  touch(join(root, "shared/mentions.ts"), newer);
  assert.equal(webDistStale(root), true);
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
  const skipped = await ensureWebDist(root, async () => {
    calls += 1;
  });
  assert.equal(skipped, false);
  assert.equal(calls, 2);
});

test("构建失败不留下会被当成最新的 dist", async (t) => {
  const root = repo(t);
  touch(join(root, "web/style.css"), recent);
  let calls = 0;
  await assert.rejects(
    () =>
      ensureWebDist(root, async () => {
        calls += 1;
        // 模拟 vite：报错前已经写出了 index.html
        touch(join(root, "dist/index.html"), newer, "<html>");
        throw new Error("依赖没装好");
      }),
    /依赖没装好/,
  );
  assert.equal(calls, 1);
  assert.equal(
    existsSync(join(root, "dist/index.html")),
    false,
    "失败的产物已清掉",
  );
  assert.equal(webDistStale(root), true, "下次启动仍判定过期");
  const built = await ensureWebDist(root, async () => {
    calls += 1;
    touch(join(root, "dist/index.html"), newer, "<html>");
  });
  assert.equal(calls, 2);
  assert.equal(built, true);
});

test("并发 ensureWebDist 只构建一次", async (t) => {
  const root = repo(t);
  touch(join(root, "web/style.css"), recent);
  let calls = 0;
  const build = () =>
    ensureWebDist(root, async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      touch(join(root, "dist/index.html"), recent, "<html>");
    });
  const results = await Promise.all([build(), build(), build()]);
  assert.equal(calls, 1);
  assert.equal(results.filter(Boolean).length, 1);
});
