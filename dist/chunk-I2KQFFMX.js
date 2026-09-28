import {
  commandInvocation
} from "./chunk-P53LWH5T.js";

// server/install-version.ts
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
async function installVersion(version, repo) {
  const source = repo.startsWith("github:") ? `https://github.com/${repo.slice("github:".length)}.git` : repo;
  const dir = mkdtempSync(join(tmpdir(), "atrium-install-"));
  const checkout = join(dir, "source");
  const npm = async (args, options) => {
    const call = commandInvocation("npm", args);
    return execFileAsync(call.command, call.args, {
      ...options,
      env: process.env,
      windowsHide: true,
      windowsVerbatimArguments: call.verbatim
    });
  };
  try {
    await execFileAsync(
      "git",
      ["clone", "--depth", "1", "--branch", `v${version}`, source, checkout],
      {
        cwd: dir,
        timeout: 6e4
      }
    );
    const pkg = JSON.parse(
      readFileSync(join(checkout, "package.json"), "utf8")
    );
    if (pkg.version !== version)
      throw new Error(`\u7248\u672C\u6807\u7B7E v${version} \u7684\u5185\u5BB9\u7248\u672C\u662F ${pkg.version}`);
    const { stdout } = await npm(
      ["pack", "--json", "--pack-destination", dir],
      { cwd: checkout, timeout: 6e4 }
    );
    const files = JSON.parse(stdout);
    if (files.length !== 1 || !/^atrium-[\d.]+\.tgz$/.test(files[0].filename))
      throw new Error("\u7248\u672C\u4EA7\u7269\u6253\u5305\u5931\u8D25");
    await npm(["install", "-g", join(dir, files[0].filename)], {
      cwd: dir,
      timeout: 24e4
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export {
  installVersion
};
