import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  inspectTemplateLinks,
  repairTemplateLinks,
} from "../server/identity-links.ts";

const file = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const link = (path: string, target: string) => {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
};

test("fix only absolute template links in an old identity, even across path aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-links-"));
  try {
    const template = join(root, "template"),
      identity = join(root, "identity"),
      outside = join(root, "external"),
      alias = join(root, "template-alias");
    file(
      join(template, "npm/node_modules/foo/bin/foo"),
      "#!/bin/sh\necho foo\n",
    );
    link(join(template, "npm/node_modules/.bin/command"), "../foo/bin/foo");
    file(
      join(identity, "npm/node_modules/foo/bin/foo"),
      "#!/bin/sh\necho own\n",
    );
    file(join(identity, "settings.json"), "unaltered");
    file(outside, "outside");
    link(alias, template);
    const ownBin = join(identity, "npm/node_modules/.bin");
    const relativeLink = join(ownBin, "relative"),
      loopLink = join(ownBin, "loop"),
      outsideLink = join(ownBin, "outside"),
      missingLink = join(ownBin, "missing"),
      absoluteLink = join(ownBin, "absolute"),
      chainedLink = join(ownBin, "chained"),
      aliasLink = join(ownBin, "alias");
    link(relativeLink, "../foo/bin/foo");
    link(loopLink, loopLink);
    link(outsideLink, outside);
    link(missingLink, join(template, "npm/node_modules/no-longer-installed"));
    link(absoluteLink, join(template, "npm/node_modules/foo/bin/foo"));
    link(chainedLink, join(template, "npm/node_modules/.bin/command"));
    link(aliasLink, join(alias, "npm/node_modules/foo/bin/foo"));
    const before = inspectTemplateLinks(identity, alias);
    assert.equal(before.rewrites.length, 3);
    assert.deepEqual(
      before.errors.map((item) => item.path),
      [loopLink],
    );
    assert.deepEqual(
      before.missing.map((item) => item.path),
      [missingLink],
    );
    assert.equal(
      readlinkSync(absoluteLink),
      join(template, "npm/node_modules/foo/bin/foo"),
    );
    const warnings: string[] = [];
    const first = repairTemplateLinks(identity, alias, (line) =>
      warnings.push(line),
    );
    assert.equal(first.repaired, 3);
    assert.equal(first.missing, 1);
    assert.equal(first.failed, 1);
    assert.match(warnings.join("\n"), /对应目标不存在/);
    assert.match(warnings.join("\n"), /跳过无法扫描的链接或目录/);
    for (const path of [absoluteLink, aliasLink, chainedLink]) {
      assert.equal(
        readlinkSync(path),
        relative(dirname(path), join(identity, "npm/node_modules/foo/bin/foo")),
      );
      assert.equal(
        realpathSync(path),
        realpathSync(join(identity, "npm/node_modules/foo/bin/foo")),
      );
    }
    assert.equal(readlinkSync(relativeLink), "../foo/bin/foo");
    assert.equal(readlinkSync(loopLink), loopLink);
    assert.equal(readlinkSync(outsideLink), outside);
    assert.equal(
      readlinkSync(missingLink),
      join(template, "npm/node_modules/no-longer-installed"),
    );
    assert.equal(
      readFileSync(join(identity, "settings.json"), "utf8"),
      "unaltered",
    );
    assert.equal(
      readFileSync(join(template, "npm/node_modules/foo/bin/foo"), "utf8"),
      "#!/bin/sh\necho foo\n",
    );
    const second = repairTemplateLinks(identity, alias, () => {});
    assert.deepEqual(
      {
        repaired: second.repaired,
        missing: second.missing,
        failed: second.failed,
      },
      { repaired: 0, missing: 1, failed: 1 },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accept an identity directory alias and repair directory and template-root links", () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-links-root-"));
  try {
    const template = join(root, "template"),
      identity = join(root, "identity"),
      alias = join(root, "identity-alias");
    file(join(template, "package/file"), "template");
    file(join(identity, "package/file"), "own");
    link(alias, identity);
    link(join(identity, "template-root"), template);
    link(join(identity, "package-dir"), join(template, "package"));
    assert.equal(inspectTemplateLinks(alias, template).rewrites.length, 2);
    assert.equal(repairTemplateLinks(alias, template).repaired, 2);
    assert.equal(readlinkSync(join(identity, "template-root")), ".");
    assert.equal(
      realpathSync(join(alias, "package-dir/file")),
      realpathSync(join(identity, "package/file")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keep links whose identity counterpart still reaches outside the identity", () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-links-external-"));
  try {
    const template = join(root, "template"),
      identity = join(root, "identity");
    const templateFile = join(template, "npm/package/bin/command"),
      identityFile = join(identity, "npm/package/bin/command"),
      command = join(identity, "npm/.bin/command");
    file(templateFile, "template");
    file(join(root, "outside"), "outside");
    link(identityFile, join(root, "outside"));
    link(command, templateFile);
    const warnings: string[] = [];
    const result = repairTemplateLinks(identity, template, (line) =>
      warnings.push(line),
    );
    assert.equal(result.repaired, 0);
    assert.equal(result.missing, 1);
    assert.equal(readlinkSync(command), templateFile);
    assert.match(warnings[0]!, /不在身份内/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
