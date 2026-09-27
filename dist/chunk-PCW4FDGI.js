import {
  packageRoot
} from "./chunk-K5INMQVZ.js";

// server/releases.ts
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
function readLocalReleases(root = packageRoot) {
  const file = join(root, "releases.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
function parseSemver(v) {
  const trimmed = v.trim();
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (!m) throw new Error(`\u65E0\u6548\u7684\u8BED\u4E49\u5316\u7248\u672C\u53F7\uFF1A${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""];
}
function compareSemver(a, b) {
  let pa;
  let pb;
  try {
    pa = parseSemver(a);
  } catch {
    pa = [0, 0, 0, a];
  }
  try {
    pb = parseSemver(b);
  } catch {
    pb = [0, 0, 0, b];
  }
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  if (pa[3] && !pb[3]) return -1;
  if (!pa[3] && pb[3]) return 1;
  if (pa[3] && pb[3]) return pa[3].localeCompare(pb[3]);
  return 0;
}
async function listRemoteTags(repoUrl) {
  try {
    let target = repoUrl;
    if (target.startsWith("github:")) {
      target = `https://github.com/${target.slice("github:".length)}.git`;
    }
    const { stdout } = await execFileAsync(
      "git",
      ["ls-remote", "--tags", target],
      { cwd: homedir(), timeout: 15e3 }
    );
    const tags = /* @__PURE__ */ new Set();
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.endsWith("^{}")) continue;
      const match = /refs\/tags\/(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(
        trimmed
      );
      if (match) tags.add(match[1].replace(/^v/, ""));
    }
    return [...tags].sort(compareSemver);
  } catch (error) {
    throw new Error(`\u83B7\u53D6\u8FDC\u7AEF\u7248\u672C\u5931\u8D25\uFF1A${error.message}`);
  }
}
function getChangesBetween(fromVersion, toVersion, releases = readLocalReleases()) {
  const fromClean = fromVersion.replace(/^v/, "");
  const toClean = toVersion.replace(/^v/, "");
  if (compareSemver(fromClean, toClean) >= 0) {
    return [];
  }
  const versions = Object.keys(releases).sort(compareSemver);
  const result = [];
  for (const v of versions) {
    const vClean = v.replace(/^v/, "");
    if (compareSemver(vClean, fromClean) > 0 && compareSemver(vClean, toClean) <= 0) {
      result.push({ version: vClean, summary: releases[v] ?? "\u7248\u672C\u66F4\u65B0" });
    }
  }
  if (result.length === 0) {
    result.push({
      version: toClean,
      summary: releases[toClean] ?? "\u7248\u672C\u66F4\u65B0"
    });
  }
  return result;
}

export {
  compareSemver,
  listRemoteTags,
  getChangesBetween
};
