import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareProfile, syncIdentityProfile } from "../server/profile.ts";
import { changePackages } from "../server/identity-packages.ts";

function inspect(dir: string, template: string) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) inspect(path, template);
    else if (item.isSymbolicLink() && item.name !== "auth.json")
      assert(!readlinkSync(path).includes(template), path);
    else if (item.name.endsWith(".json")) {
      const value = JSON.parse(readFileSync(path, "utf8"));
      const walk = (node: unknown): void => {
        if (typeof node === "string")
          assert(!node.includes(template), `${path}: ${node}`);
        else if (Array.isArray(node)) node.forEach(walk);
        else if (node && typeof node === "object")
          Object.values(node).forEach(walk);
      };
      walk(value);
    }
  }
}

test("身份独立于模板：相对/绝对链接、本地包与配置路径；凭据暂共享", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-independent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const template = join(root, "template");
  const npm = join(template, "npm/node_modules/demo");
  const local = join(template, "dev-ext");
  const skill = join(template, "skills/example");
  const tools = join(template, "tools");
  const notes = join(template, "notes");
  for (const dir of [npm, local, skill, tools, join(notes, "backups")])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(npm, "package.json"), '{"name":"demo","version":"1"}');
  mkdirSync(join(template, "npm/node_modules/.bin"), { recursive: true });
  symlinkSync(
    "../demo/package.json",
    join(template, "npm/node_modules/.bin/relative"),
  );
  symlinkSync(
    join(npm, "package.json"),
    join(template, "npm/node_modules/.bin/absolute"),
  );
  const external = join(root, "outside");
  writeFileSync(external, "external");
  symlinkSync(external, join(template, "npm/node_modules/.bin/external"));
  writeFileSync(
    join(local, "package.json"),
    JSON.stringify({ name: "local", entry: join(local, "main.js") }),
  );
  writeFileSync(join(local, "main.js"), "own module");
  symlinkSync(join(local, "main.js"), join(local, "entry.js"));
  writeFileSync(join(skill, "SKILL.md"), `Run ${join(tools, "runner.js")}`);
  writeFileSync(join(tools, "runner.js"), "tool");
  writeFileSync(join(notes, "backups", "old-evidence.txt"), "not inherited");
  writeFileSync(
    join(notes, "history.md"),
    `曾存于 ${join(template, "backups", "old-evidence.txt")}`,
  );
  writeFileSync(
    join(template, "notes.json"),
    JSON.stringify({ directory: notes }),
  );
  writeFileSync(
    join(template, "settings.json"),
    JSON.stringify({
      packages: ["npm:demo", local],
      extensions: [join(template, "extensions")],
      theme: join(template, "themes", "absent.json"),
    }),
  );
  writeFileSync(
    join(template, "mcp.json"),
    JSON.stringify({
      servers: { tool: { command: "node", args: [join(tools, "runner.js")] } },
    }),
  );
  writeFileSync(
    join(template, "models.json"),
    JSON.stringify({ path: join(tools, "runner.js") }),
  );
  writeFileSync(join(template, "auth.json"), '{"demo":"private"}');
  const target = prepareProfile("id1", template, join(root, "pi"));
  inspect(target, template);
  assert.equal(existsSync(join(target, "notes/backups")), false);
  assert.equal(existsSync(join(target, "backups")), false);
  assert.match(
    readFileSync(join(target, "notes/history.md"), "utf8"),
    /原身份备份未继承/,
  );
  assert.equal(
    readFileSync(join(target, "skills/example/SKILL.md"), "utf8"),
    `Run ${join(target, "tools/runner.js")}`,
  );
  const settings = JSON.parse(
    readFileSync(join(target, "settings.json"), "utf8"),
  ) as { packages: string[] };
  const localCopy = settings.packages.find((p) => p.includes("/local/"))!;
  assert.equal(readFileSync(join(localCopy, "main.js"), "utf8"), "own module");
  assert.equal(readFileSync(join(localCopy, "entry.js"), "utf8"), "own module");
  assert.equal(
    readlinkSync(join(target, "npm/node_modules/.bin/relative")),
    "../demo/package.json",
  );
  assert.equal(
    readlinkSync(join(target, "npm/node_modules/.bin/absolute")),
    "../demo/package.json",
  );
  assert.equal(
    readlinkSync(join(target, "npm/node_modules/.bin/external")),
    external,
  );
  assert.equal(
    readlinkSync(join(target, "auth.json")),
    realpathSync(join(template, "auth.json")),
  );
  assert.equal(syncIdentityProfile(target).length, 0);
  assert.equal(
    readlinkSync(join(target, "auth.json")),
    realpathSync(join(template, "auth.json")),
  );
  for (const value of ["npm:demo", localCopy]) {
    changePackages(target, { action: "disable", spec: value });
    changePackages(target, { action: "enable", spec: value });
  }
  inspect(target, template);
  renameSync(npm, `${npm}-hidden`);
  renameSync(local, `${local}-hidden`);
  assert(existsSync(join(target, "npm/node_modules/.bin/absolute")));
  assert.equal(readFileSync(join(localCopy, "main.js"), "utf8"), "own module");
});
