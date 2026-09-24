import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clone } from "../server/clone.ts";

test("克隆与 Node 复制一致：链接保留或跟随、权限、已有目录中的冲突", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-clone-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const from = join(root, "source");
  mkdirSync(from, { mode: 0o750 });
  writeFileSync(join(from, "data"), "original", { mode: 0o640 });
  symlinkSync("data", join(from, "link"));
  for (const dereference of [false, true]) {
    const actual = join(root, `actual-${dereference}`);
    const expected = join(root, `expected-${dereference}`);
    clone(from, actual, { recursive: true, dereference });
    cpSync(from, expected, { recursive: true, dereference });
    assert.equal(readFileSync(join(actual, "data"), "utf8"), "original");
    assert.equal(
      lstatSync(actual).mode & 0o777,
      lstatSync(expected).mode & 0o777,
    );
    assert.equal(
      lstatSync(join(actual, "data")).mode & 0o777,
      lstatSync(join(expected, "data")).mode & 0o777,
    );
    assert.equal(
      lstatSync(join(actual, "link")).isSymbolicLink(),
      !dereference,
    );
    if (!dereference)
      assert.equal(
        readlinkSync(join(actual, "link")),
        readlinkSync(join(expected, "link")),
      );
  }
  for (const dereference of [false, true]) {
    const actual = join(root, `file-actual-${dereference}`);
    const expected = join(root, `file-expected-${dereference}`);
    clone(join(from, "link"), actual, { recursive: true, dereference });
    cpSync(join(from, "link"), expected, { recursive: true, dereference });
    assert.equal(
      lstatSync(actual).isSymbolicLink(),
      lstatSync(expected).isSymbolicLink(),
    );
    if (!dereference)
      assert.equal(readlinkSync(actual), readlinkSync(expected));
    else assert.equal(readFileSync(actual, "utf8"), "original");
  }
  for (const dir of ["merge", "node-merge"]) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, "data"), "mine");
  }
  clone(from, join(root, "merge"), {
    recursive: true,
    dereference: true,
    force: false,
    errorOnExist: false,
  });
  cpSync(from, join(root, "node-merge"), {
    recursive: true,
    dereference: true,
    force: false,
    errorOnExist: false,
  });
  for (const name of ["data", "link"])
    assert.equal(
      readFileSync(join(root, "merge", name), "utf8"),
      readFileSync(join(root, "node-merge", name), "utf8"),
    );
  assert.equal(readFileSync(join(root, "merge", "data"), "utf8"), "mine");
  assert.throws(
    () =>
      clone(from, join(root, "merge"), {
        recursive: true,
        force: false,
        errorOnExist: true,
      }),
    /exist/i,
  );
});

test("克隆命令部分写入后失败：清理半成品、普通复制完成并只记一次退回", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-clone-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "data"), "intact");
  const warnings: string[] = [];
  t.mock.method(console, "warn", (text: string) => warnings.push(text));
  for (const index of [1, 2]) {
    const target = join(root, `target-${index}`);
    clone(source, target, { recursive: true }, (_cmd, args) => {
      mkdirSync(args.at(-1)!);
      writeFileSync(join(target, "partial"), "bad");
      throw new Error("simulated cp failure");
    });
    assert.equal(readFileSync(join(target, "data"), "utf8"), "intact");
    assert.throws(() => readFileSync(join(target, "partial")));
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /已退回普通复制.*simulated cp failure/);
});
