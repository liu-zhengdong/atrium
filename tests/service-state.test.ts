import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claimService, readService } from "../server/service-state.ts";
import { removeTemp } from "./temp-dir.ts";

test("登记文件写坏（断电等）：读当作没有服务，登记时挪开重建", (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => errors.push(message));
  const data = mkdtempSync(join(tmpdir(), "atrium-registry-"));
  t.after(() => removeTemp(data));
  const path = join(data, "service.sqlite");
  writeFileSync(path, "不是数据库".repeat(200));
  assert.equal(readService(data), null);

  const lease = claimService(data, 4999);
  try {
    assert.deepEqual(readService(data), lease.record);
    const aside = readdirSync(data).filter((name) =>
      name.startsWith("service.sqlite.damaged-"),
    );
    assert.equal(aside.length, 1, `坏文件挪开留存：${aside.join("，")}`);
    assert.match(errors.join("\n"), /服务登记文件损坏，已挪到 .* 并重建/);
  } finally {
    lease.release();
  }
  assert.equal(readService(data), null);
});

test("登记文件完好时照常读写，不挪文件", (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-registry-"));
  t.after(() => removeTemp(data));
  const lease = claimService(data, 4999);
  lease.release();
  const again = claimService(data, 4998);
  try {
    assert.equal(readService(data)?.port, 4998);
    assert.deepEqual(
      readdirSync(data).filter((name) => name.includes("damaged")),
      [],
    );
  } finally {
    again.release();
  }
});
