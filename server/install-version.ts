import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, runFile, type FileRun } from "./platform/index.ts";

const ok = (run: FileRun) => {
  if (run.error) throw run.error;
  return run;
};

/** Install an immutable tag, not a Git URL symlink. npm 11 links local git+file
 * installs to a temporary clone and deletes the clone, leaving a broken bin. */
export async function installVersion(version: string, repo: string) {
  const source = repo.startsWith("github:")
    ? `https://github.com/${repo.slice("github:".length)}.git`
    : repo;
  const dir = mkdtempSync(join(tmpdir(), "atrium-install-"));
  const checkout = join(dir, "source");
  // Windows 上 npm 是 npm.cmd，由平台层经 cmd.exe 拉起。
  const npm = async (
    args: string[],
    options: { cwd: string; timeout: number },
  ) => ok(await runCommand("npm", args, { ...options, env: process.env }));
  try {
    ok(
      await runFile(
        "git",
        ["clone", "--depth", "1", "--branch", `v${version}`, source, checkout],
        {
          cwd: dir,
          timeout: 60000,
        },
      ),
    );
    const pkg = JSON.parse(
      readFileSync(join(checkout, "package.json"), "utf8"),
    ) as {
      version: string;
    };
    if (pkg.version !== version)
      throw new Error(`版本标签 v${version} 的内容版本是 ${pkg.version}`);
    const { stdout } = await npm(
      ["pack", "--json", "--pack-destination", dir],
      { cwd: checkout, timeout: 60000 },
    );
    const files = JSON.parse(stdout) as Array<{ filename: string }>;
    if (files.length !== 1 || !/^atrium-[\d.]+\.tgz$/.test(files[0].filename))
      throw new Error("版本产物打包失败");
    await npm(["install", "-g", join(dir, files[0].filename)], {
      cwd: dir,
      timeout: 240000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
