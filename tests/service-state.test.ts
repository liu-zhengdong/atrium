import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claimService, readService } from "../server/service-state.ts";
import { tempDir } from "./temp-dir.ts";

/**
 * 造热日志文件：写一个包含合法 SQLite 日志头的 -journal 文件，并把数据库头的
 * change counter 改掉，让 SQLite 认为需要回滚。只读连接无法回滚，就会报
 * "attempt to write a readonly database"（SQLITE_READONLY，errcode=8）。
 */
function createHotJournal(dbPath: string) {
  const dbBuf = Buffer.from(readFileSync(dbPath));
  const pageSize = dbBuf.readUInt16BE(16) || 4096;

  // SQLite 回滚日志头（28 字节）：
  //   魔数（8）+ 页数（4）+ nonce（4）+ 初始页大小（4）+ 扇区大小（4）+ 页大小（4）
  const headerSize = 28;
  // 一条记录：页码（4）+ 页数据（pageSize）+ 校验和（4）
  const recordSize = 4 + pageSize + 4;
  const journal = Buffer.alloc(headerSize + recordSize);
  // 魔数：d9 d5 05 f9 20 a1 63 d7
  Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]).copy(
    journal,
    0,
  );
  journal.writeUInt32BE(1, 8); // 1 条记录
  journal.writeUInt32BE(0x12345678, 12); // 随机 nonce
  journal.writeUInt32BE(512, 16); // 初始页大小
  journal.writeUInt32BE(512, 20); // 扇区大小
  journal.writeUInt32BE(pageSize, 24); // 页大小
  // 记录：页码 1 + 原始第一页数据
  journal.writeUInt32BE(1, headerSize);
  dbBuf.copy(journal, headerSize + 4, 0, Math.min(pageSize, dbBuf.length));

  writeFileSync(`${dbPath}-journal`, journal);

  // 改数据库头的 file change counter（偏移 24，4 字节大端），使之与日志中记录的不一致。
  // 这让 SQLite 判定日志是热的、需要回滚。
  const counter = dbBuf.readUInt32BE(24);
  dbBuf.writeUInt32BE(counter + 1, 24);
  // 同时改 version-valid-for 字段（偏移 92）使之不匹配，双重确认日志是热的。
  dbBuf.writeUInt32BE(counter + 1, 92);
  writeFileSync(dbPath, dbBuf);
}

test("崩溃留下热日志（-journal）：读登记不报错，当作没有服务", (t) => {
  const data = tempDir(t, "atrium-registry-");
  const path = join(data, "service.sqlite");

  // 先造一个合法的登记库，写入一条记录。
  const setup = new DatabaseSync(path);
  setup.exec("PRAGMA journal_mode=DELETE");
  setup.exec(
    "CREATE TABLE service (id INTEGER PRIMARY KEY CHECK(id=1), record TEXT NOT NULL)",
  );
  setup.prepare("INSERT INTO service(id,record) VALUES(1,?)").run(
    JSON.stringify({
      instance: "00000000-0000-4000-8000-000000000001",
      pid: 999999,
      port: 4310,
      token: "a".repeat(64),
    }),
  );
  setup.close();

  // 模拟崩溃：创建热日志文件。
  createHotJournal(path);
  assert.equal(existsSync(`${path}-journal`), true, "日志文件应存在");

  // 修复前这里会抛 "attempt to write a readonly database"。
  // 修复后 readService 返回 null：有热日志意味着服务崩溃了，按无服务处理。
  assert.equal(readService(data), null, "有热日志时 readService 应返回 null");
});

test("崩溃留下热日志后 claimService 正常回滚并登记", (t) => {
  const data = tempDir(t, "atrium-registry-");
  const path = join(data, "service.sqlite");

  // 造合法库并留下热日志。
  const setup = new DatabaseSync(path);
  setup.exec("PRAGMA journal_mode=DELETE");
  setup.exec(
    "CREATE TABLE service (id INTEGER PRIMARY KEY CHECK(id=1), record TEXT NOT NULL)",
  );
  setup.prepare("INSERT INTO service(id,record) VALUES(1,?)").run(
    JSON.stringify({
      instance: "00000000-0000-4000-8000-000000000001",
      pid: 999999,
      port: 4310,
      token: "a".repeat(64),
    }),
  );
  setup.close();
  createHotJournal(path);

  // claimService 以读写方式打开，SQLite 自动回滚热日志后正常登记。
  const lease = claimService(data, 4999);
  try {
    assert.deepEqual(readService(data), lease.record);
    // 读写打开能自动回滚，不需要挪文件。
    assert.deepEqual(
      readdirSync(data).filter((name) => name.includes("damaged")),
      [],
      "热日志能自动回滚，不需要挪开",
    );
    assert.equal(
      existsSync(`${path}-journal`),
      false,
      "日志已被 SQLite 回滚清理",
    );
  } finally {
    lease.release();
  }
});

test("登记文件写坏（断电等）：读当作没有服务，登记时挪开重建", (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => errors.push(message));
  const data = tempDir(t, "atrium-registry-");
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
  const data = tempDir(t, "atrium-registry-");
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
