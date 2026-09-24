import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installVersion } from "../server/install-version.ts";
import { getChangesBetween, listRemoteTags } from "../server/releases.ts";
import { currentVersion, dataDirectory } from "../server/service-state.ts";
import { recordNext, recordResult } from "./contract.ts";
import { Problem } from "../server/problem.ts";

export async function update({ to, repo }: { to?: string; repo?: string }) {
  const current = currentVersion();
  const repoSource =
    repo ?? process.env.ATRIUM_UPDATE_REPO ?? "github:liu-zhengdong/atrium";

  const tags = await listRemoteTags(repoSource);
  let targetVersion: string;

  if (to) {
    targetVersion = to.replace(/^v/, "");
    if (!tags.includes(targetVersion)) {
      throw new Problem(
        404,
        `未找到版本 v${targetVersion}。可用版本：${tags.map((t) => `v${t}`).join("、")}`,
        "not_found",
      );
    }
  } else {
    if (tags.length === 0) {
      console.log(`已是最新版本（v${current}）`);
      recordResult({ from: current, to: current, updated: false });
      return;
    }
    targetVersion = tags[tags.length - 1];
  }

  if (targetVersion === current) {
    console.log(`已是最新版本（v${current}）`);
    recordResult({ from: current, to: current, updated: false });
    return;
  }

  const data = dataDirectory();
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const pendingPath = join(data, "pending-update.json");
  const previous = existsSync(pendingPath)
    ? (JSON.parse(readFileSync(pendingPath, "utf8")) as { from: string })
    : null;
  try {
    await installVersion(targetVersion, repoSource);
  } catch (err) {
    throw new Problem(
      500,
      `更新安装失败：${(err as Error).message}`,
      "internal",
    );
  }

  writeFileSync(
    pendingPath,
    JSON.stringify({
      from: previous?.from ?? current,
      to: targetVersion,
      repo: repoSource,
    }),
    { mode: 0o600 },
  );
  const changes = getChangesBetween(current, targetVersion);
  console.log(`${current} → ${targetVersion}`);
  for (const c of changes) {
    console.log(`- ${c.version}：${c.summary}`);
  }

  recordResult({
    from: current,
    to: targetVersion,
    changes,
    updated: true,
  });
  recordNext("生效：atrium restart");
}
