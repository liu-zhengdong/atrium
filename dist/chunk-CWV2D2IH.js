// server/problem.ts
var Problem = class extends Error {
  constructor(statusCode, message, code, candidates, nextCommand) {
    super(message);
    this.statusCode = statusCode;
    this.candidates = candidates;
    this.nextCommand = nextCommand;
    this.code = code ?? {
      400: "usage",
      404: "not_found",
      403: "conflict",
      409: "conflict",
      503: "service_unavailable"
    }[statusCode] ?? "internal";
  }
  statusCode;
  candidates;
  nextCommand;
  code;
};
function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        next[j - 1] + 1,
        row[j] + 1,
        row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    row = next;
  }
  return row[b.length];
}
function closest(reference, entries) {
  const distance = editDistance;
  const input = reference.toLowerCase();
  return entries.map((entry) => ({
    entry,
    score: entry.ref.toLowerCase() === input ? -2 : entry.ref.toLowerCase().startsWith(input) || entry.name.toLowerCase().startsWith(input) ? -1 : Math.min(
      distance(input, entry.name.toLowerCase()),
      distance(input, entry.name.toLowerCase().split(/\s+/)[0])
    )
  })).sort(
    (a, b) => a.score - b.score || a.entry.ref.localeCompare(b.entry.ref, void 0, { numeric: true })
  ).slice(0, 3).map(({ entry }) => ({ ref: entry.ref, name: entry.name }));
}

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
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
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
    const { stdout } = await execFileAsync(
      npmCmd,
      ["pack", "--json", "--pack-destination", dir],
      {
        cwd: checkout,
        env: process.env,
        timeout: 6e4
      }
    );
    const files = JSON.parse(stdout);
    if (files.length !== 1 || !/^atrium-[\d.]+\.tgz$/.test(files[0].filename))
      throw new Error("\u7248\u672C\u4EA7\u7269\u6253\u5305\u5931\u8D25");
    await execFileAsync(
      npmCmd,
      ["install", "-g", join(dir, files[0].filename)],
      {
        cwd: dir,
        env: process.env,
        timeout: 24e4
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export {
  Problem,
  closest,
  installVersion
};
