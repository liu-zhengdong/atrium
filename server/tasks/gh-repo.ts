import { exec as defaultExec, firstLine, type Exec } from "./git.ts";

/**
 * 运行时 gh 调用的目标仓库（#262）：一律显式 `-R`，不让 gh 按本地远端自己猜。
 * fork 仓库同时有 origin 与 upstream 时 gh 默认解析到上游，关卡会查错地方（t27）。
 * 仓库从任务仓库的 origin 远端解析；解析不出就明确报错，不回落到 gh 默认。
 */

export type GhRepo = { host: string; owner: string; name: string };

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

function fromPath(host: string, path: string): GhRepo | null {
  const parts = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (!host || !SEGMENT.test(owner) || !SEGMENT.test(name)) return null;
  if (owner.startsWith(".") || name.startsWith(".")) return null;
  return { host: host.toLowerCase(), owner, name };
}

/** 远端地址 → 仓库：https / ssh:// / git:// 与 scp 写法（git@host:owner/repo.git）；本地路径与其他写法返回 null。 */
export function parseRemote(url: string): GhRepo | null {
  const text = url.trim();
  const scheme =
    /^(?:https?|ssh|git|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?(\/.*)$/i.exec(
      text,
    );
  if (scheme) return fromPath(scheme[1]!, scheme[2]!);
  if (text.includes("://")) return null;
  const scp = /^(?:[^@/:]+@)?([^/:]+):([^/].*)$/.exec(text);
  if (scp) return fromPath(scp[1]!, scp[2]!);
  return null;
}

/** PR 链接 → 仓库：https://host/owner/repo/pull/N。 */
export function parsePrUrl(url: string): GhRepo | null {
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/.exec(
    url.trim(),
  );
  return match ? fromPath(match[1]!, `${match[2]}/${match[3]}`) : null;
}

/** 给 `-R` 的写法：github.com 用 owner/repo，其他主机用 host/owner/repo。 */
export function repoFlag(repo: GhRepo) {
  const slug = `${repo.owner}/${repo.name}`;
  return repo.host === "github.com" ? slug : `${repo.host}/${slug}`;
}

/** `gh api` 不收 `-R`：路径写全，非 github.com 主机另带 --hostname。 */
export function apiArgs(repo: GhRepo, path: string) {
  return [
    "api",
    `repos/${repo.owner}/${repo.name}/${path}`,
    ...(repo.host === "github.com" ? [] : ["--hostname", repo.host]),
  ];
}

export async function originRepo(
  repo: string,
  run: Exec = defaultExec,
): Promise<{ repo: GhRepo } | { error: string }> {
  const url = await run("git", ["-C", repo, "remote", "get-url", "origin"], {
    timeoutMs: 10_000,
  });
  if (!url.ok)
    return {
      error: `读不到仓库 ${repo} 的 origin 远端：${firstLine(url.stderr) || "git 失败"}`,
    };
  const parsed = parseRemote(url.stdout);
  if (!parsed)
    return {
      error: `origin 远端 ${firstLine(url.stdout)} 解析不出 owner/repo，不能确定 gh 查询的仓库`,
    };
  return { repo: parsed };
}
