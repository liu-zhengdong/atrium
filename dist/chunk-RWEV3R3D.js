import {
  recordNext,
  recordResult
} from "./chunk-TWHVF7L2.js";
import {
  installVersion
} from "./chunk-AJ73NCVO.js";
import {
  getChangesBetween,
  listRemoteTags
} from "./chunk-AT7C2M5U.js";
import {
  currentVersion,
  dataDirectory
} from "./chunk-IF66WVAY.js";
import {
  Problem
} from "./chunk-QCD2PKZ3.js";

// cli/update.ts
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
async function update({ to, repo }) {
  const current = currentVersion();
  const repoSource = repo ?? process.env.ATRIUM_UPDATE_REPO ?? "github:liu-zhengdong/atrium";
  const tags = await listRemoteTags(repoSource);
  let targetVersion;
  if (to) {
    targetVersion = to.replace(/^v/, "");
    if (!tags.includes(targetVersion)) {
      throw new Problem(
        404,
        `\u672A\u627E\u5230\u7248\u672C v${targetVersion}\u3002\u53EF\u7528\u7248\u672C\uFF1A${tags.map((t) => `v${t}`).join("\u3001")}`,
        "not_found"
      );
    }
  } else {
    if (tags.length === 0) {
      console.log(`\u5DF2\u662F\u6700\u65B0\u7248\u672C\uFF08v${current}\uFF09`);
      recordResult({ from: current, to: current, updated: false });
      return;
    }
    targetVersion = tags[tags.length - 1];
  }
  if (targetVersion === current) {
    console.log(`\u5DF2\u662F\u6700\u65B0\u7248\u672C\uFF08v${current}\uFF09`);
    recordResult({ from: current, to: current, updated: false });
    return;
  }
  const data = dataDirectory();
  mkdirSync(data, { recursive: true, mode: 448 });
  const pendingPath = join(data, "pending-update.json");
  const previous = existsSync(pendingPath) ? JSON.parse(readFileSync(pendingPath, "utf8")) : null;
  try {
    await installVersion(targetVersion, repoSource);
  } catch (err) {
    throw new Problem(
      500,
      `\u66F4\u65B0\u5B89\u88C5\u5931\u8D25\uFF1A${err.message}`,
      "internal"
    );
  }
  writeFileSync(
    pendingPath,
    JSON.stringify({
      from: previous?.from ?? current,
      to: targetVersion,
      repo: repoSource
    }),
    { mode: 384 }
  );
  const changes = getChangesBetween(current, targetVersion);
  console.log(`${current} \u2192 ${targetVersion}`);
  for (const c of changes) {
    console.log(`- ${c.version}\uFF1A${c.summary}`);
  }
  recordResult({
    from: current,
    to: targetVersion,
    changes,
    updated: true
  });
  recordNext("\u751F\u6548\uFF1Aatrium restart");
}
export {
  update
};
