import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
import { Problem } from "./store.ts";

export const SETUP_TOKEN_FILE = "claude-setup-token";
export const SETUP_PROVIDER = "claude-bridge";
export function checkedSetupToken(value: string): string {
  const token = value.trim();
  if (!/^\S{8,4096}$/.test(token))
    throw new Problem(400, "setup-token 格式不正确");
  return token;
}

// One billed Haiku turn against the supplied credential, with no shared Claude
// configuration, model tools or inherited API keys. Never include CLI output in errors.
export async function validateSetupToken(value: string, executable = "claude") {
  const token = checkedSetupToken(value);
  const home = mkdtempSync(join(tmpdir(), "atrium-setup-check-"));
  try {
    // A positive result must come only from the supplied token, never another
    // inherited provider credential or the user's logged-in Claude config.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      TMPDIR: process.env.TMPDIR,
      HOME: home,
      CLAUDE_CONFIG_DIR: home,
      XDG_CONFIG_HOME: home,
      CLAUDE_CODE_OAUTH_TOKEN: token,
    };
    let response: unknown;
    try {
      const result = await exec(
        executable,
        [
          "--print",
          "--safe-mode",
          "--no-session-persistence",
          "--output-format",
          "json",
          "--model",
          "claude-haiku-4-5",
          "Reply OK.",
        ],
        {
          cwd: home,
          env,
          encoding: "utf8",
          timeout: 30000,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024,
        },
      );
      response = JSON.parse(result.stdout);
    } catch {
      /* CLI failures, timeouts and malformed JSON are all invalid. Never echo output. */
    }
    if (
      !response ||
      typeof response !== "object" ||
      (response as { is_error?: boolean }).is_error !== false
    )
      throw new Problem(
        400,
        "setup-token 验证失败；请检查令牌与 Claude CLI 后重试",
      );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function secretPath(root: string, number: number) {
  const dir = join(root, `k${number}`);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Problem(400, "账号编号无效");
  return { dir, file: join(dir, SETUP_TOKEN_FILE) };
}
export function readSetupToken(root: string, number: number): string {
  const { dir, file } = secretPath(root, number);
  try {
    const directory = lstatSync(dir);
    if (
      !directory.isDirectory() ||
      directory.uid !== process.getuid?.() ||
      directory.mode & 0o077 ||
      realpathSync(dir) !== join(realpathSync(root), `k${number}`) ||
      realpathSync(file) !== join(realpathSync(dir), SETUP_TOKEN_FILE)
    )
      throw new Error("insecure account directory");
    const stat = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.size > 4097
    )
      throw new Error("insecure file");
    return checkedSetupToken(readFileSync(file, "utf8"));
  } catch {
    throw new Problem(
      409,
      `账号 k${number} 的 setup-token 文件缺失或不可安全读取`,
    );
  }
}
export function writeSetupToken(root: string, number: number, value: string) {
  const token = checkedSetupToken(value);
  const { dir, file } = secretPath(root, number);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(dir);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    directory.mode & 0o077 ||
    realpathSync(dir) !== join(realpathSync(root), `k${number}`)
  )
    throw new Problem(409, "账号目录权限不安全");
  const temp = join(dir, `${SETUP_TOKEN_FILE}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, token + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } finally {
    rmSync(temp, { force: true });
  }
}
