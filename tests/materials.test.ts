import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { userTokenPath } from "../server/user-auth.ts";
import {
  contextMaterialLines,
  HINT_AGAIN_MS,
  hintDue,
  MATERIAL_MAX_BYTES,
  nameOf,
  noteOf,
  parseLinks,
  parseMaterialRef,
  pathProblem,
  purgeVerdict,
  PURGE_ARCHIVED_MS,
  PURGE_MIN_BYTES,
  segmentProblem,
  staleVerdict,
  STALE_MS,
  validateUpload,
  type StaleFacts,
} from "../server/materials/model.ts";
import { versionDir } from "../server/materials/store.ts";
import { publishMaterialHints } from "../server/materials/hints.ts";
import { formatContext } from "../server/map/context.ts";
import { leaderRule } from "../server/leaders/scope.ts";
import type { LeaderRunSpec } from "../server/leaders/runtime.ts";
import { collect } from "../cli/materials.ts";
import { workerReadable } from "../cli/worker-guard.ts";
import { until } from "./task-fixture.ts";
import { removeTemp } from "./temp-dir.ts";

/**
 * 资料（t192 第 1 步）：纯函数（短号、路径、名称、关联、上传校验、清理线索、真删、派活清单）穷举；
 * 集成走内存服务：加、新版本、取、读取记录、归档恢复、留下、取代、全景与派活清单、leader 权限、
 * 周期任务顺带发线索、真删、破坏输入与旧运行时表。
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 8, 28, 12).getTime();
const b64 = (text: string) => Buffer.from(text).toString("base64");

// ---- 纯函数 ----

test("资料短号：只认 mN，报参数名", () => {
  assert.equal(parseMaterialRef("m1"), 1);
  assert.equal(parseMaterialRef(" m42 "), 42);
  for (const bad of ["1", "m0", "t1", "m-1", "m1.5", "", null, 3])
    assert.throws(
      () => parseMaterialRef(bad, "--supersedes"),
      /--supersedes: 资料短号/,
    );
});

test("路径校验：拒绝 ..、绝对路径、盘符、反斜杠、隐藏段、空段与控制字符", () => {
  for (const ok of [
    "a.md",
    "shots/root-light-1440.png",
    "深/层/文件 名.txt",
    "a..b",
  ])
    assert.equal(pathProblem(ok), null, ok);
  const cases: [string, RegExp][] = [
    ["", /不能为空/],
    ["..", /\.\./],
    ["a/../b", /\.\./],
    ["./a", /\.\./],
    ["/etc/passwd", /绝对路径/],
    ["C:/Windows", /绝对路径/],
    ["\\\\server\\x", /绝对路径/],
    ["a\\b", /反斜杠/],
    ["ab:c", /冒号/],
    ["a:b", /绝对路径/],
    [".git/config", /隐藏/],
    ["shots/.png", /隐藏/],
    ["a//b", /空的一段/],
    ["a/", /空的一段/],
    ["a\u0000b", /控制字符/],
    [`${"长".repeat(256)}`, /255/],
  ];
  for (const [path, pattern] of cases)
    assert.match(pathProblem(path) ?? "", pattern, JSON.stringify(path));
  assert.equal(segmentProblem("ok"), null);
});

test("名称、说明与关联：名称一段且不隐藏；说明有上限；关联只认 tN kN dN 且去重", () => {
  assert.equal(nameOf(" t120-tasks "), "t120-tasks");
  for (const [bad, pattern] of [
    ["", /不能为空/],
    ["a/b", /不能含 \//],
    [".env", /隐藏/],
    ["..", /\.\./],
    ["名".repeat(81), /80/],
  ] as const)
    assert.throws(() => nameOf(bad), pattern);
  assert.equal(noteOf(undefined), null);
  assert.equal(noteOf("  两行\n说明 "), "两行 说明");
  assert.throws(() => noteOf("", "--note", true), /--note: 要写一句话/);
  assert.throws(() => noteOf("字".repeat(201)), /200/);
  assert.deepEqual(parseLinks("t120, k3，d5 t120"), [
    { kind: "task", id: 120 },
    { kind: "point", id: 3 },
    { kind: "decision", id: 5 },
  ]);
  assert.deepEqual(parseLinks(undefined), []);
  assert.throws(() => parseLinks("t1,g2"), /--for: g2/);
  assert.throws(
    () => parseLinks(Array.from({ length: 21 }, (_, i) => `t${i + 1}`)),
    /最多关联 20/,
  );
});

test("上传校验：字段、kind、base64、重名、数量与大小上限，单文件路径即名称；文件按路径排序", () => {
  const ok = validateUpload({
    node: " o4 ",
    kind: "dir",
    name: "t120-tasks",
    note: "设计稿",
    for: "t120",
    supersedes: "m2",
    files: [
      { path: "shots/b.png", data: b64("bb") },
      { path: "README.md", data: b64("readme") },
    ],
  });
  assert.equal(ok.node, "o4");
  assert.deepEqual(
    ok.files.map((f) => f.path),
    ["README.md", "shots/b.png"],
  );
  assert.equal(ok.size, 8);
  assert.equal(ok.supersedes, 2);
  assert.deepEqual(ok.links, [{ kind: "task", id: 120 }]);
  const base = {
    node: "o4",
    kind: "dir",
    name: "x",
    files: [{ path: "a.md", data: b64("a") }],
  };
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ...base, extra: 1 }, /extra: 是未知字段/],
    [{ ...base, node: "" }, /节点: /],
    [{ ...base, kind: "link" }, /kind: 应为 file 或 dir/],
    [{ ...base, files: [] }, /没有可加的文件/],
    [{ ...base, files: [{ path: "../a", data: b64("a") }] }, /\.\./],
    [{ ...base, files: [{ path: "/etc/x", data: b64("a") }] }, /绝对路径/],
    [{ ...base, files: [{ path: ".env", data: b64("a") }] }, /隐藏/],
    [{ ...base, files: [{ path: "a.md", data: "不是base64" }] }, /base64/],
    [
      {
        ...base,
        files: [
          { path: "a.md", data: b64("a") },
          { path: "a.md", data: b64("b") },
        ],
      },
      /重复/,
    ],
    [{ ...base, kind: "file", name: "b.md" }, /单个文件的资料/],
    [{ ...base, supersedes: "t1" }, /--supersedes/],
  ];
  for (const [body, pattern] of cases)
    assert.throws(() => validateUpload(body), pattern, JSON.stringify(body));
  assert.throws(
    () =>
      validateUpload(
        { ...base, files: [{ path: "a.md", data: b64("12345") }] },
        4,
      ),
    /超过上限.*压缩.*--note/,
  );
  assert.throws(() => validateUpload([]), /请求体应为对象/);
});

test("清理线索：归档与留下不提；被取代的提；90 天没读且关联都结束才提；读过从读取算", () => {
  const facts = (over: Partial<StaleFacts>): StaleFacts => ({
    archived_at: null,
    keep_at: null,
    superseded_by: null,
    updated_at: NOW - 100 * DAY,
    last_read_at: null,
    links: [],
    ...over,
  });
  assert.equal(staleVerdict(facts({}), NOW)?.kind, "unused");
  assert.match(staleVerdict(facts({}), NOW)!.reason, /加上后 100 天没人读/);
  assert.equal(staleVerdict(facts({ archived_at: NOW - DAY }), NOW), null);
  assert.equal(staleVerdict(facts({ keep_at: NOW - DAY }), NOW), null);
  assert.equal(
    staleVerdict(facts({ keep_at: NOW, superseded_by: 3 }), NOW),
    null,
  );
  assert.deepEqual(
    staleVerdict(facts({ superseded_by: 3, updated_at: NOW }), NOW),
    { kind: "superseded", reason: "已被 m3 取代" },
  );
  // 最近读过、最近加了新版本：都不算没用。
  assert.equal(
    staleVerdict(facts({ last_read_at: NOW - 10 * DAY }), NOW),
    null,
  );
  assert.equal(staleVerdict(facts({ updated_at: NOW - 10 * DAY }), NOW), null);
  assert.equal(
    staleVerdict(facts({ updated_at: NOW - STALE_MS + 1 }), NOW),
    null,
  );
  assert.equal(
    staleVerdict(facts({ updated_at: NOW - STALE_MS }), NOW)?.kind,
    "unused",
  );
  assert.match(
    staleVerdict(facts({ last_read_at: NOW - 95 * DAY }), NOW)!.reason,
    /^95 天没人读$/,
  );
  // 关联：有没结束的就不提；都结束了注明。
  assert.equal(staleVerdict(facts({ links: [true, false] }), NOW), null);
  assert.match(
    staleVerdict(facts({ links: [true, true] }), NOW)!.reason,
    /关联的都已结束/,
  );
});

test("线索间隔与真删：没发过马上提、发过隔 30 天；归档一年以上且大于 10 MB、没问过才列", () => {
  assert.equal(hintDue(null, NOW), true);
  assert.equal(hintDue(NOW - HINT_AGAIN_MS + 1, NOW), false);
  assert.equal(hintDue(NOW - HINT_AGAIN_MS, NOW), true);
  const old = NOW - PURGE_ARCHIVED_MS;
  const big = PURGE_MIN_BYTES + 1;
  assert.equal(
    purgeVerdict({ archived_at: old, bytes: big, purge_asked_at: null }, NOW),
    true,
  );
  for (const facts of [
    { archived_at: null, bytes: big, purge_asked_at: null },
    { archived_at: old + 1, bytes: big, purge_asked_at: null },
    { archived_at: old, bytes: PURGE_MIN_BYTES, purge_asked_at: null },
    { archived_at: old, bytes: big, purge_asked_at: NOW - DAY },
  ])
    assert.equal(purgeVerdict(facts, NOW), false, JSON.stringify(facts));
});

test("派活清单：近的节点在前、同层新的在前，至多 8 条其余给命令；进 context 时比要点低，挤掉时标题一起去掉", () => {
  const list = Array.from({ length: 10 }, (_, i) => ({
    ref: `m${i + 1}`,
    name: `资料${i + 1}`,
    note: i === 0 ? "" : `说明${i + 1}`,
    node: i < 5 ? "o4" : "o1",
    distance: i < 5 ? 0 : 2,
    updated_at: i,
  }));
  const lines = contextMaterialLines(list, "o4");
  assert.equal(lines.length, 9);
  assert.equal(lines[0], "- m5 资料5：说明5（o4）");
  assert.equal(lines[4], "- m1 资料1：（没写说明）（o4）");
  assert.equal(lines[5], "- m10 资料10：说明10（o1）");
  assert.match(lines[8]!, /还有 2 份：atrium material ls --node o4/);
  assert.deepEqual(contextMaterialLines([], "o4"), []);
  const chain = [
    { ref: "o1", name: "组织", alias: "", analogy: "", what: "" },
    { ref: "o4", name: "规矩", alias: "", analogy: "", what: "有哪些部分" },
  ];
  const input = {
    chain,
    parts: [],
    now: "",
    next: "",
    points: [
      {
        name: "规矩",
        points: [{ text: "要点甲", why: "原因", by: "u1", check: null }],
      },
    ],
    materials: list.slice(0, 2),
  };
  const full = formatContext(input, "o4").text;
  assert.match(full, /资料（本节点及上级挂的；要看就 atrium material get mN/);
  assert.match(full, /- m2 资料2：说明2（o4）/);
  assert.ok(full.indexOf("要点甲") < full.indexOf("资料（"));
  // 很紧时先丢资料清单、留要点，资料标题不单独留下。
  const tight = formatContext(input, "o4", 140).text;
  assert.match(tight, /要点甲/);
  assert.doesNotMatch(tight, /资料（/);
});

test("命令行收集：目录下文件按 / 分段，隐藏文件跳过；目录外的软链接报错、目录里的照收；执行者只放行 material get", () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-material-collect-"));
  try {
    const dir = join(root, "t120-tasks");
    mkdirSync(join(dir, "shots"), { recursive: true });
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "README.md"), "说明");
    writeFileSync(join(dir, "shots", "a.png"), "png");
    writeFileSync(join(dir, "shots", ".png"), "隐藏");
    writeFileSync(join(dir, ".DS_Store"), "x");
    writeFileSync(join(dir, ".git", "config"), "x");
    const found = collect(dir);
    assert.equal(found.kind, "dir");
    assert.equal(found.name, "t120-tasks");
    assert.deepEqual(
      found.files.map((f) => f.path),
      ["README.md", "shots/a.png"],
    );
    assert.deepEqual(found.skipped.sort(), [".DS_Store", ".git", "shots/.png"]);
    const single = collect(join(dir, "README.md"));
    assert.deepEqual(
      {
        kind: single.kind,
        name: single.name,
        paths: single.files.map((f) => f.path),
      },
      { kind: "file", name: "README.md", paths: ["README.md"] },
    );
    assert.throws(() => collect(join(root, "没有")), /读不到/);
    // 超过上限的先按大小拒绝，不读内容。
    writeFileSync(join(root, "big.bin"), Buffer.alloc(MATERIAL_MAX_BYTES + 1));
    assert.throws(() => collect(join(root, "big.bin")), /超过上限 20\.0 MB/);
    // Windows 建软链接要权限，只在 Unix 上验。
    if (process.platform !== "win32") {
      writeFileSync(join(root, "secret.txt"), "外面的");
      symlinkSync(join(dir, "README.md"), join(dir, "inside.md"));
      assert.deepEqual(
        collect(dir).files.map((f) => f.path),
        ["README.md", "inside.md", "shots/a.png"],
      );
      symlinkSync(join(root, "secret.txt"), join(dir, "outside.txt"));
      assert.throws(() => collect(dir), /outside\.txt 是指向目录外的软链接/);
    }
  } finally {
    removeTemp(root);
  }
  assert.equal(workerReadable("material", ["get", "m1"]), true);
  for (const [name, rest] of [
    ["material", ["add", "o4", "x"]],
    ["material", ["ls"]],
    ["task", ["get"]],
    [undefined, []],
  ] as const)
    assert.equal(workerReadable(name, rest), false);
});

test("leader 权限表：加、归档、恢复、留下按节点判，取资料放行，真删与其余拒绝", () => {
  assert.equal(leaderRule("POST", "/api/materials"), "material-add");
  for (const action of ["archive", "restore", "keep"])
    assert.equal(
      leaderRule("POST", `/api/materials/:id/${action}`),
      "material",
    );
  assert.equal(leaderRule("POST", "/api/materials/:id/get"), "material-read");
  assert.equal(leaderRule("GET", "/api/materials/:id/files"), "read");
  assert.equal(leaderRule("DELETE", "/api/materials/:id"), "deny");
});

// ---- 集成 ----

async function open(t: { after: (fn: () => unknown) => void }) {
  const data = mkdtempSync(join(tmpdir(), "atrium-materials-"));
  t.after(() => removeTemp(data));
  // 旧运行时留下的 attachments 表：不读不写，也不妨碍启动。
  const legacy = new DatabaseSync(join(data, "atrium.sqlite"));
  legacy.exec(
    "CREATE TABLE attachments (id TEXT PRIMARY KEY, path TEXT); INSERT INTO attachments VALUES ('x','旧附件');",
  );
  legacy.close();
  const runs: LeaderRunSpec[] = [];
  let behave: (spec: LeaderRunSpec) => Promise<"ok"> = async () => "ok";
  let clock = NOW;
  const created = await createApp({
    data,
    auth: true,
    controlToken: "c".repeat(64),
    tasks: { pace: async () => undefined },
    leaders: {
      batchMs: 0,
      pollMs: 20,
      run: async (spec) => {
        runs.push(spec);
        return behave(spec);
      },
    },
    schedules: { tickMs: 3_600_000, now: () => clock },
  });
  t.after(() => created.app.close());
  const user = `Bearer ${readFileSync(userTokenPath(data), "utf8").trim()}`;
  const call = async (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
    authorization = user,
  ) => {
    const response = await created.app.inject({
      method,
      url,
      headers: { host: "127.0.0.1", authorization },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return {
      status: response.statusCode,
      body: response.body ? (response.json() as Record<string, any>) : {},
    };
  };
  const ok = async (...args: Parameters<typeof call>) => {
    const result = await call(...args);
    assert(
      result.status < 300,
      `${args[0]} ${args[1]} → ${result.status} ${JSON.stringify(result.body)}`,
    );
    return result.body;
  };
  for (const [parent, slug, kind, name] of [
    [undefined, "org", "org", "组织"],
    ["o1", "atrium", "project", "Atrium"],
    ["o2", "rules", "module", "组织和规矩"],
    ["o1", "quota", "project", "OpenQuota"],
  ] as const)
    await ok("POST", "/api/org/nodes", {
      ...(parent ? { parent } : {}),
      slug,
      kind,
      name,
      reason: "建",
    });
  return {
    ...created,
    data,
    runs,
    call,
    ok,
    set: (next: typeof behave) => {
      behave = next;
    },
    tick: (ms: number) => {
      clock += ms;
      return clock;
    },
  };
}

const design = (readme = "设计说明") => ({
  node: "o3",
  kind: "dir",
  name: "t120-tasks",
  note: "t120 任务视图设计稿",
  files: [
    { path: "README.md", data: b64(readme) },
    { path: "shots/root.png", data: b64("png-bytes") },
  ],
});

test("加资料、再加是新版本（内容没变不加）、取文件记读者、旧版本照样能取；破坏输入逐条拒绝；旧表不动", async (t) => {
  const x = await open(t);
  const added = await x.call("POST", "/api/materials", design());
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.outcome, "new");
  const m = added.body.material;
  assert.equal(m.ref, "m1");
  assert.equal(m.node, "o3");
  assert.equal(m.version, 1);
  assert.equal(m.files, 2);
  assert.equal(m.created_by, "secretary");
  assert.equal(
    readFileSync(join(versionDir(x.data, 1, 1), "shots", "root.png"), "utf8"),
    "png-bytes",
  );
  // 同样内容再加：不出新版本。
  assert.equal(
    (await x.ok("POST", "/api/materials", design())).outcome,
    "unchanged",
  );
  // 改了：v2，说明不给就沿用。
  const v2 = await x.ok("POST", "/api/materials", {
    ...design("改过的说明"),
    note: undefined,
  });
  assert.equal(v2.outcome, "version");
  assert.equal(v2.material.version, 2);
  assert.equal(v2.material.note, "t120 任务视图设计稿");

  // 取：清单 + 逐个文件；读者记成秘书，带任务的记成任务。
  const task = await x.ok("POST", "/api/tasks", {
    title: "照设计稿做任务视图",
    part: "o3",
    deliver: "none",
  });
  const opened = await x.ok("POST", "/api/materials/m1/get", {
    task: task.ref,
  });
  assert.equal(opened.version, 2);
  assert.deepEqual(
    opened.files.map((f: { path: string }) => f.path),
    ["README.md", "shots/root.png"],
  );
  const file = await x.ok(
    "GET",
    "/api/materials/m1/files?version=2&path=README.md",
  );
  assert.equal(Buffer.from(file.data, "base64").toString(), "改过的说明");
  const old = await x.ok(
    "GET",
    "/api/materials/m1/files?version=1&path=README.md",
  );
  assert.equal(Buffer.from(old.data, "base64").toString(), "设计说明");
  await x.ok("POST", "/api/materials/m1/get", { version: "v1" });
  const shown = await x.ok("GET", "/api/materials/m1");
  assert.deepEqual(
    shown.versions.map((v: { version: number }) => v.version),
    [2, 1],
  );
  assert.deepEqual(
    shown.reads.map((r: { reader: string; version: number }) => [
      r.reader,
      r.version,
    ]),
    [
      ["secretary", 1],
      [task.ref, 2],
    ],
  );
  assert.equal(shown.last_read_by, "secretary");

  // 破坏输入：路径、未知字段、坏短号、没说明的新资料、目录外的读取。
  const bad: [string, string, unknown, number, RegExp][] = [
    [
      "POST",
      "/api/materials",
      { ...design(), files: [{ path: "../x", data: b64("x") }] },
      400,
      /\.\./,
    ],
    [
      "POST",
      "/api/materials",
      { ...design(), files: [{ path: "/etc/passwd", data: b64("x") }] },
      400,
      /绝对路径/,
    ],
    [
      "POST",
      "/api/materials",
      { ...design(), files: [{ path: ".git/config", data: b64("x") }] },
      400,
      /隐藏/,
    ],
    [
      "POST",
      "/api/materials",
      { ...design(), name: "另一份", note: undefined },
      400,
      /--note: 新资料要写一句话/,
    ],
    ["POST", "/api/materials", { ...design(), node: "o99" }, 404, /o99/],
    [
      "POST",
      "/api/materials",
      { ...design(), for: "t999" },
      404,
      /--for: t999 不存在/,
    ],
    ["POST", "/api/materials", { ...design(), kind: "file" }, 400, /单个文件/],
    [
      "GET",
      "/api/materials/m1/files?path=../../atrium.sqlite",
      undefined,
      400,
      /\.\./,
    ],
    [
      "GET",
      "/api/materials/m1/files?path=%2Fetc%2Fpasswd",
      undefined,
      400,
      /绝对路径/,
    ],
    [
      "GET",
      "/api/materials/m1/files?path=nothere.md",
      undefined,
      404,
      /没有 nothere\.md/,
    ],
    [
      "GET",
      "/api/materials/m1/files?version=9&path=README.md",
      undefined,
      404,
      /没有版本 v9/,
    ],
    [
      "POST",
      "/api/materials/m1/get",
      { reader: "a1" },
      400,
      /reader: 是未知字段/,
    ],
    ["GET", "/api/materials/x1", undefined, 400, /资料短号/],
    ["GET", "/api/materials/m9", undefined, 404, /m9 不存在/],
    ["POST", "/api/materials/m1/keep", {}, 400, /留下要写一句原因/],
  ];
  for (const [method, url, body, status, pattern] of bad) {
    const result = await x.call(method as "GET", url, body);
    assert.equal(
      result.status,
      status,
      `${method} ${url} ${JSON.stringify(result.body)}`,
    );
    assert.match(result.body.error, pattern, url);
  }
  // 旧运行时的附件表原样。
  assert.deepEqual(
    { ...(x.db.prepare("SELECT id,path FROM attachments").get() as object) },
    { id: "x", path: "旧附件" },
  );
});

test("取代、归档、恢复、留下：归档的不进清单与派活附带，可恢复；全景节点页有资料；真删只有用户", async (t) => {
  const x = await open(t);
  await x.ok("POST", "/api/materials", design());
  await x.ok("POST", "/api/materials", {
    node: "o2",
    kind: "file",
    name: "调研.md",
    note: "竞品调研",
    files: [{ path: "调研.md", data: b64("调研内容") }],
  });
  // 派活附带：本节点（o3）与上级（o2）的都列，近的在前。
  const context = (await x.ok("GET", "/api/map/context/o3")) as {
    text: string;
  };
  assert.match(
    context.text,
    /资料（本节点及上级[^\n]*\n- m1 t120-tasks：t120 任务视图设计稿（o3）\n- m2 调研\.md：竞品调研（o2）/,
  );
  // 另一个不在链上的节点看不到。
  assert.doesNotMatch(
    ((await x.ok("GET", "/api/map/context/o4")) as { text: string }).text,
    /资料（/,
  );

  // m3 取代 m2：m2 进清理线索、不再进派活附带。
  await x.ok("POST", "/api/materials", {
    node: "o2",
    kind: "file",
    name: "调研-新.md",
    note: "新一轮竞品调研",
    supersedes: "m2",
    files: [{ path: "调研-新.md", data: b64("新") }],
  });
  const shown = await x.ok("GET", "/api/materials/m2");
  assert.equal(shown.superseded_by, "m3");
  assert.deepEqual(shown.stale, { kind: "superseded", reason: "已被 m3 取代" });
  assert.deepEqual((await x.ok("GET", "/api/materials/m3")).supersedes, ["m2"]);
  const stale = await x.ok("GET", "/api/materials/stale?node=o2");
  assert.deepEqual(
    stale.stale.map((m: { ref: string }) => m.ref),
    ["m2"],
  );
  assert.doesNotMatch(
    ((await x.ok("GET", "/api/map/context/o3")) as { text: string }).text,
    /m2 /,
  );

  // 归档：不进 ls 与派活附带，--archived 能看到，可恢复。
  const archived = await x.ok("POST", "/api/materials/m1/archive", {
    note: "已上线",
  });
  assert.equal(archived.archived, true);
  assert.equal(
    (await x.call("POST", "/api/materials/m1/archive", {})).status,
    409,
  );
  assert.deepEqual(
    (await x.ok("GET", "/api/materials")).materials.map(
      (m: { ref: string }) => m.ref,
    ),
    ["m3", "m2"],
  );
  assert.deepEqual(
    (await x.ok("GET", "/api/materials?archived=1")).materials.map(
      (m: { ref: string }) => m.ref,
    ),
    ["m1"],
  );
  assert.doesNotMatch(
    ((await x.ok("GET", "/api/map/context/o3")) as { text: string }).text,
    /m1 /,
  );
  // 归档的仍可取。
  assert.equal((await x.ok("POST", "/api/materials/m1/get", {})).ref, "m1");
  // 归档后同名的可以另挂一份；此时恢复旧的会撞名。
  await x.ok("POST", "/api/materials", { ...design("第二份"), note: "重做" });
  const clash = await x.call("POST", "/api/materials/m1/restore", {});
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /已有同名的 m4/);
  await x.ok("POST", "/api/materials/m4/archive", {});
  assert.equal(
    (await x.ok("POST", "/api/materials/m1/restore", { note: "还要用" }))
      .archived,
    false,
  );

  // 留下：写原因，清理线索不再提。
  await x.ok("POST", "/api/materials/m2/keep", { note: "留作对照" });
  assert.deepEqual((await x.ok("GET", "/api/materials/stale")).stale, []);

  // 分页。
  const page = await x.ok("GET", "/api/materials?limit=1");
  assert.equal(page.materials.length, 1);
  assert.equal(page.next_before, "m3");
  assert.equal((await x.call("GET", "/api/materials?limit=0")).status, 400);

  // 全景节点页。
  const node = await x.ok("GET", "/api/map/nodes/o3");
  assert.deepEqual(
    node.materials.map((m: { ref: string; archived: boolean }) => [
      m.ref,
      m.archived,
    ]),
    [
      ["m1", false],
      ["m4", true],
    ],
  );

  // 真删：库与文件一起删。
  assert.ok(existsSync(versionDir(x.data, 4, 1)));
  assert.equal((await x.ok("DELETE", "/api/materials/m4")).ref, "m4");
  assert.equal(existsSync(join(x.data, "materials", "m4")), false);
  assert.equal((await x.call("GET", "/api/materials/m4")).status, 404);
});

test("leader 令牌：负责的部分里能加、归档、留下，别处的不行；哪儿的资料都能取；不能真删", async (t) => {
  const x = await open(t);
  await x.ok("POST", "/api/materials", design());
  await x.ok("POST", "/api/materials", {
    node: "o4",
    kind: "file",
    name: "额度.md",
    note: "额度接口说明",
    files: [{ path: "额度.md", data: b64("q") }],
  });
  await x.ok("POST", "/api/leaders", { name: "规矩负责人", worker: "codex" });
  await x.ok("PATCH", "/api/org/nodes/o3", { leader: "a1", reason: "指派" });
  await x.ok("POST", "/api/tasks", {
    title: "待处理",
    part: "o3",
    deliver: "none",
  });
  let checked = false;
  let failure: unknown;
  x.set(async (spec) => {
    if (checked || failure) return "ok";
    try {
      assert.match(spec.prompt, /atrium material archive mN --note 原因/);
      const token = `Bearer ${spec.env.ATRIUM_LEADER_TOKEN}`;
      const add = await x.call(
        "POST",
        "/api/materials",
        { ...design(), name: "a1 的", note: "leader 加的" },
        token,
      );
      assert.equal(add.status, 201, JSON.stringify(add.body));
      assert.equal(add.body.material.created_by, "a1");
      const outside = await x.call(
        "POST",
        "/api/materials",
        { ...design(), node: "o4", name: "越界" },
        token,
      );
      assert.equal(outside.status, 403);
      assert.match(outside.body.error, /不在你负责的部分里/);
      assert.equal(
        (
          await x.call(
            "POST",
            "/api/materials/m1/keep",
            { note: "还要" },
            token,
          )
        ).status,
        200,
      );
      const archiveOther = await x.call(
        "POST",
        "/api/materials/m2/archive",
        {},
        token,
      );
      assert.equal(archiveOther.status, 403);
      assert.match(archiveOther.body.error, /资料 m2（挂在 o4）/);
      const got = await x.call("POST", "/api/materials/m2/get", {}, token);
      assert.equal(got.status, 200);
      const rm = await x.call("DELETE", "/api/materials/m1", undefined, token);
      assert.equal(rm.status, 403);
      assert.match(rm.body.error, /真删资料/);
      checked = true;
    } catch (error) {
      failure = error;
    }
    return "ok";
  });
  const { publishTask } = await import("../server/tasks/notice.ts");
  publishTask(x.taskRunner.inbox, x.db, 1, "failed", { reason: "测试没过" });
  await until(() => checked || failure !== undefined, 20000);
  if (failure) throw failure;
  assert.equal((await x.ok("GET", "/api/materials/m2")).last_read_by, "a1");
});

test("清理线索：周期任务到点时把疑似没用的投给这一块的 leader，隔 30 天再提；大而久的归档问秘书一次", async (t) => {
  const x = await open(t);
  await x.ok("POST", "/api/materials", design());
  const task = await x.ok("POST", "/api/tasks", {
    title: "还在做",
    part: "o3",
    deliver: "none",
  });
  await x.ok("POST", "/api/materials", {
    node: "o3",
    kind: "file",
    name: "在用.md",
    note: "关联着没结束的任务",
    for: task.ref,
    files: [{ path: "在用.md", data: b64("x") }],
  });
  // 两份都是 100 天前加的、没人读过。
  x.db
    .prepare("UPDATE materials SET updated_at=?,created_at=?")
    .run(NOW - 100 * DAY, NOW - 100 * DAY);
  const inbox = x.taskRunner.inbox;
  const events = () =>
    x.db
      .prepare(
        "SELECT subscriber,kind,detail,count FROM task_inbox WHERE kind IN ('material_stale','material_purge') ORDER BY id",
      )
      .all() as {
      subscriber: string;
      kind: string;
      detail: string;
      count: number;
    }[];

  // 周期任务：o3 下每天一轮，到点手动跑一轮（派发失败不影响线索）。
  const schedule = await x.ok("POST", "/api/schedules", {
    node: "o3",
    title: "例行巡检",
    every: "1d",
  });
  await x.call("POST", `/api/schedules/${schedule.ref}/run`, {});
  let list = events();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.subscriber, "secretary");
  const detail = JSON.parse(list[0]!.detail);
  assert.equal(detail.node, "o3");
  assert.deepEqual(
    detail.materials.map((m: { ref: string; reason: string }) => [
      m.ref,
      m.reason,
    ]),
    [["m1", "加上后 100 天没人读"]],
  );
  // 马上再跑：发过的不重复提。
  assert.deepEqual(publishMaterialHints(x.db, inbox, 3, NOW + DAY), {
    stale: 0,
    purge: 0,
  });
  // 30 天后 leader 还没决定：再提一次。
  assert.equal(publishMaterialHints(x.db, inbox, 3, NOW + 31 * DAY).stale, 1);
  // 留下之后不再提。
  await x.ok("POST", "/api/materials/m1/keep", { note: "留作对照" });
  assert.equal(publishMaterialHints(x.db, inbox, 3, NOW + 62 * DAY).stale, 0);

  // 归档超过一年且（全部版本）大于 10 MB：问秘书一次。
  await x.ok("POST", "/api/materials/m2/archive", {});
  x.db
    .prepare("UPDATE material_versions SET bytes=? WHERE material_id=2")
    .run(PURGE_MIN_BYTES + 1);
  const later = Date.now() + PURGE_ARCHIVED_MS + DAY;
  assert.equal(publishMaterialHints(x.db, inbox, 2, later).purge, 1);
  assert.equal(publishMaterialHints(x.db, inbox, 2, later + DAY).purge, 0);
  list = events();
  const purge = list.find((e) => e.kind === "material_purge")!;
  assert.equal(purge.subscriber, "secretary");
  assert.match(JSON.parse(purge.detail).materials[0].reason, /共 10\.0 MB/);
});
