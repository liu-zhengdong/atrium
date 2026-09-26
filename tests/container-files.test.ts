import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readContainerFile,
  writeContainerFile,
} from "../server/container-files.ts";
import { Problem } from "../server/problem.ts";

const rejected = (fn: () => unknown) =>
  assert.throws(
    fn,
    (error: unknown) => error instanceof Problem && error.statusCode === 409,
  );

test("容器树只读普通有界文件，FIFO 和大文件不能卡死或撑爆 Web", () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-container-files-"));
  try {
    const identity = join(root, "identity");
    mkdirSync(identity);
    writeFileSync(join(identity, "settings.json"), "ok");
    assert.equal(readContainerFile(identity, "settings.json").toString(), "ok");
    execFileSync("mkfifo", [join(identity, "fifo")]);
    // A removed O_NONBLOCK would hang a synchronous open: contain the negative probe.
    const code = `import {readContainerFile} from './server/container-files.ts';
      try {readContainerFile(${JSON.stringify(identity)}, 'fifo'); process.exit(2)}
      catch (e) {if(e.statusCode !== 409) throw e; process.stdout.write('409')}`;
    const fifo = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      {
        encoding: "utf8",
        timeout: 5_000,
      },
    );
    assert.equal(fifo.status, 0, fifo.error?.message ?? fifo.stderr);
    assert.equal(fifo.stdout, "409");
    writeFileSync(join(identity, "SKILL.md"), Buffer.alloc(1024 * 1024 + 1));
    rejected(() => readContainerFile(identity, "SKILL.md"));
    assert.equal(readContainerFile(identity, "settings.json").toString(), "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("宿主不跟身份树的外链和路径字段，也不写出树外", () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-container-files-"));
  try {
    const identity = join(root, "identity"),
      other = join(root, "other");
    mkdirSync(identity);
    mkdirSync(other);
    writeFileSync(join(other, "auth.json"), "foreign-secret");
    symlinkSync(join(other, "auth.json"), join(identity, "auth.json"));
    symlinkSync(other, join(identity, "notes"));
    // This assertion fails if the negative test fixture does not expose a real leak.
    assert.equal(
      readFileSync(join(identity, "auth.json"), "utf8"),
      "foreign-secret",
    );
    rejected(() => readContainerFile(identity, "auth.json"));
    rejected(() => readContainerFile(identity, "notes/auth.json"));
    rejected(() => readContainerFile(identity, "../other/auth.json"));
    rejected(() => readContainerFile(identity, join(other, "auth.json")));
    rejected(() => writeContainerFile(identity, "auth.json", "overwrite"));
    rejected(() =>
      writeContainerFile(identity, "notes/auth.json", "overwrite"),
    );
    rejected(() =>
      writeContainerFile(identity, "../other/auth.json", "overwrite"),
    );
    assert.equal(
      readFileSync(join(other, "auth.json"), "utf8"),
      "foreign-secret",
    );
    writeContainerFile(identity, "settings.json", "own");
    assert.equal(
      readContainerFile(identity, "settings.json").toString(),
      "own",
    );
    writeContainerFile(identity, "settings.json", "changed");
    assert.equal(
      readContainerFile(identity, "settings.json").toString(),
      "changed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
