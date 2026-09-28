import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runFile } from "./platform/index.ts";
import { packageRoot } from "./service-state.ts";

export type ReleaseChange = {
  version: string;
  summary: string;
};

export function readLocalReleases(root = packageRoot): Record<string, string> {
  const file = join(root, "releases.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function parseSemver(v: string): [number, number, number, string] {
  const trimmed = v.trim();
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (!m) throw new Error(`无效的语义化版本号：${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""];
}

export function compareSemver(a: string, b: string): number {
  let pa: [number, number, number, string];
  let pb: [number, number, number, string];
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
    if (pa[i] !== pb[i]) return (pa[i] as number) - (pb[i] as number);
  }
  if (pa[3] && !pb[3]) return -1;
  if (!pa[3] && pb[3]) return 1;
  if (pa[3] && pb[3]) return pa[3].localeCompare(pb[3]);
  return 0;
}

export async function listRemoteTags(repoUrl: string): Promise<string[]> {
  try {
    let target = repoUrl;
    if (target.startsWith("github:")) {
      target = `https://github.com/${target.slice("github:".length)}.git`;
    }
    const { error, stdout } = await runFile(
      "git",
      ["ls-remote", "--tags", target],
      { cwd: homedir(), timeout: 15000 },
    );
    if (error) throw error;
    const tags = new Set<string>();
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.endsWith("^{}")) continue;
      const match = /refs\/tags\/(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(
        trimmed,
      );
      if (match) tags.add(match[1].replace(/^v/, ""));
    }
    return [...tags].sort(compareSemver);
  } catch (error) {
    throw new Error(`获取远端版本失败：${(error as Error).message}`);
  }
}

export function getChangesBetween(
  fromVersion: string,
  toVersion: string,
  releases = readLocalReleases(),
): ReleaseChange[] {
  const fromClean = fromVersion.replace(/^v/, "");
  const toClean = toVersion.replace(/^v/, "");
  if (compareSemver(fromClean, toClean) >= 0) {
    return [];
  }
  const versions = Object.keys(releases).sort(compareSemver);

  const result: ReleaseChange[] = [];
  for (const v of versions) {
    const vClean = v.replace(/^v/, "");
    if (
      compareSemver(vClean, fromClean) > 0 &&
      compareSemver(vClean, toClean) <= 0
    ) {
      result.push({ version: vClean, summary: releases[v] ?? "版本更新" });
    }
  }
  if (result.length === 0) {
    result.push({
      version: toClean,
      summary: releases[toClean] ?? "版本更新",
    });
  }
  return result;
}
