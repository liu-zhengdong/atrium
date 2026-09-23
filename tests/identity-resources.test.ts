import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  lstatSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DefaultPackageManager,
  SettingsManager,
  loadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";
import {
  changeSkill,
  listSkills,
  listTemplateSkills,
  planSkill,
  listRules,
  writeRule,
  readMcp,
  writeMcp,
} from "../server/identity-resources.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "atrium-resources-"));
  mkdirSync(join(dir, "skills", "sample"), { recursive: true });
  writeFileSync(
    join(dir, "skills", "sample", "SKILL.md"),
    "---\nname: sample\ndescription: sample description\n---\n",
  );
  writeFileSync(
    join(dir, "settings.json"),
    '{"skills":["!other"],"defaultModel":"test"}',
  );
  writeFileSync(join(dir, "AGENTS.md"), "original");
  writeFileSync(
    join(dir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        demo: {
          command: "node",
          env: { TOKEN: "secret" },
          headers: { Authorization: "Bearer secret" },
        },
      },
    }),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("planSkill only changes the requested Pi override, preserving other entries", () => {
  assert.deepEqual(planSkill(["!other"], "disable", "sample"), [
    "!other",
    "-skills/sample/SKILL.md",
  ]);
  assert.deepEqual(
    planSkill(["!other", "-skills/sample/SKILL.md"], "disable", "sample"),
    ["!other", "-skills/sample/SKILL.md"],
  );
  assert.deepEqual(
    planSkill(["!other", "-skills/sample/SKILL.md"], "enable", "sample"),
    ["!other"],
  );
  assert.throws(() => planSkill([], "disable", "../escape"));
});

test("skill toggles, rule writes and MCP writes back up originals; invalid input leaves files intact", (t) => {
  const dir = fixture(t);
  assert.equal(listSkills(dir)[0]?.description, "sample description");
  assert.equal(changeSkill(dir, "disable", "sample")[0]?.enabled, false);
  assert.equal(
    JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).defaultModel,
    "test",
  );
  assert.equal(changeSkill(dir, "enable", "sample")[0]?.enabled, true);
  assert.throws(() => changeSkill(dir, "remove", "../outside"));
  writeRule(dir, "AGENTS.md", "updated");
  assert.equal(listRules(dir)[0]?.text, "updated");
  assert.equal(
    loadProjectContextFiles({ cwd: dir, agentDir: dir }).find(
      (item) => item.path === join(dir, "AGENTS.md"),
    )?.content,
    "updated",
  );
  assert.throws(() => writeRule(dir, "../outside" as "AGENTS.md", "bad"));
  const before = readFileSync(join(dir, "mcp.json"), "utf8");
  assert.throws(() => writeMcp(dir, "{"), /JSON 格式无效（第 1 行，第 2 列）/);
  assert.throws(
    () => writeMcp(dir, '{\n"mcpServers": {,\n}}'),
    /第 2 行，第 \d+ 列/,
  );
  assert.throws(() => writeMcp(dir, " ".repeat(1024 * 1024 + 1)), /1 MiB/);
  assert.equal(readFileSync(join(dir, "mcp.json"), "utf8"), before);
  const shown = readMcp(dir);
  assert(!shown.text.includes("secret"));
  const edited = JSON.parse(shown.text);
  edited.mcpServers.other = { url: "https://example.test/mcp" };
  writeMcp(dir, JSON.stringify(edited));
  assert.equal(
    JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers.demo.env
      .TOKEN,
    "secret",
  );
  assert.equal(readMcp(dir).servers.length, 2);
  assert(readdirSync(dir).some((name) => name.startsWith(".atrium-backup-")));
});

test("personal template lists only copyable skills not already installed", (t) => {
  const dir = fixture(t);
  const template = mkdtempSync(join(tmpdir(), "atrium-template-"));
  const previous = process.env.ATRIUM_PI_TEMPLATE;
  process.env.ATRIUM_PI_TEMPLATE = template;
  t.after(() => {
    if (previous === undefined) delete process.env.ATRIUM_PI_TEMPLATE;
    else process.env.ATRIUM_PI_TEMPLATE = previous;
    rmSync(template, { recursive: true, force: true });
  });
  for (const key of ["sample", "available"]) {
    mkdirSync(join(template, "skills", key), { recursive: true });
    writeFileSync(
      join(template, "skills", key, "SKILL.md"),
      `---\nname: ${key}\ndescription: ${key} description\n---\n`,
    );
  }
  assert.deepEqual(listTemplateSkills(dir), [
    {
      key: "available",
      name: "available",
      description: "available description",
    },
  ]);
  changeSkill(dir, "copy", "available");
  assert.deepEqual(listTemplateSkills(dir), []);
  assert.equal(listSkills(dir).length, 2);
});

test("disabled skill disappears from Pi's resolved resources and returns after enable", async (t) => {
  const dir = fixture(t);
  const resolveSkills = async () => {
    const manager = new DefaultPackageManager({
      cwd: dir,
      agentDir: dir,
      settingsManager: SettingsManager.create(dir, dir),
    });
    return (await manager.resolve()).skills
      .filter((item) => item.enabled)
      .map((item) => item.path);
  };
  assert(
    (await resolveSkills()).some((path) => path.endsWith("sample/SKILL.md")),
  );
  changeSkill(dir, "disable", "sample");
  assert(
    !(await resolveSkills()).some((path) => path.endsWith("sample/SKILL.md")),
  );
  changeSkill(dir, "enable", "sample");
  assert(
    (await resolveSkills()).some((path) => path.endsWith("sample/SKILL.md")),
  );
});

test("linked skills list, toggle, and unlink without changing their target", (t) => {
  const dir = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), "atrium-linked-skill-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const content = "---\nname: Herdr\ndescription: linked skill\n---\n";
  writeFileSync(join(outside, "SKILL.md"), content);
  symlinkSync(outside, join(dir, "skills", "herdr"));
  assert.deepEqual(
    listSkills(dir).find((item) => item.key === "herdr"),
    {
      key: "herdr",
      name: "Herdr",
      description: "linked skill",
      enabled: true,
      linkTarget: outside,
    },
  );
  assert.equal(
    changeSkill(dir, "disable", "herdr").find((item) => item.key === "herdr")
      ?.enabled,
    false,
  );
  assert.equal(readFileSync(join(outside, "SKILL.md"), "utf8"), content);
  assert(
    JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf8"),
    ).skills.includes("-skills/herdr/SKILL.md"),
  );
  assert.throws(() => changeSkill(dir, "copy", "herdr"), /技能已存在/);
  assert.equal(
    changeSkill(dir, "enable", "herdr").find((item) => item.key === "herdr")
      ?.enabled,
    true,
  );
  changeSkill(dir, "remove", "herdr");
  assert.equal(
    JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf8"),
    ).skills.includes("-skills/herdr/SKILL.md"),
    false,
  );
  assert.equal(lstatSync(outside).isDirectory(), true);
  assert.equal(readFileSync(join(outside, "SKILL.md"), "utf8"), content);
  assert.equal(
    listSkills(dir).some((item) => item.key === "herdr"),
    false,
  );
});

test("dangling skill links remain visible, toggleable and removable", (t) => {
  const dir = fixture(t);
  const missing = join(dir, "missing-skill");
  symlinkSync(missing, join(dir, "skills", "broken"));
  assert.deepEqual(
    listSkills(dir).find((item) => item.key === "broken"),
    {
      key: "broken",
      name: "broken",
      description: "",
      enabled: true,
      linkTarget: missing,
      error: "无法读取 SKILL.md",
    },
  );
  assert.equal(
    changeSkill(dir, "disable", "broken").find((item) => item.key === "broken")
      ?.enabled,
    false,
  );
  assert.throws(() => changeSkill(dir, "copy", "broken"), /技能已存在/);
  changeSkill(dir, "remove", "broken");
  assert.equal(listSkills(dir).length, 1);
});

test("symlinks in writable rule and MCP paths are rejected", (t) => {
  const dir = fixture(t);
  const outside = join(tmpdir(), "atrium-outside-" + process.pid);
  writeFileSync(outside, "outside");
  t.after(() => rmSync(outside, { force: true }));
  rmSync(join(dir, "AGENTS.md"));
  symlinkSync(outside, join(dir, "AGENTS.md"));
  assert.throws(() => listRules(dir), /符号链接/);
  assert.throws(() => writeRule(dir, "AGENTS.md", "bad"), /符号链接/);
  assert.equal(readFileSync(outside, "utf8"), "outside");
  rmSync(join(dir, "mcp.json"));
  symlinkSync(join(dir, "missing"), join(dir, "mcp.json"));
  assert.throws(() => readMcp(dir), /符号链接/);
  rmSync(join(dir, "skills", "sample", "SKILL.md"));
  symlinkSync(outside, join(dir, "skills", "sample", "SKILL.md"));
  assert.equal(listSkills(dir)[0]?.error, "无法读取 SKILL.md");
  assert.throws(
    () => changeSkill(dir, "remove", "sample"),
    /符号链接|链接或特殊文件/,
  );
});
