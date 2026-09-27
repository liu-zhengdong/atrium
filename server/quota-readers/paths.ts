import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import type { CredentialSource, Platform } from "./types.ts";

/**
 * 各家凭据在三个平台上的位置（纯函数：只按平台、主目录和环境变量算，不读文件）。
 * 位置照 OpenQuota（src-tauri/src/providers/<家>/auth.rs、paths.rs）与各工具自己的约定：
 *
 * | 工具        | macOS                                            | Linux                                        | Windows                         |
 * | ----------- | ------------------------------------------------ | -------------------------------------------- | ------------------------------- |
 * | Claude Code | 钥匙串「Claude Code-credentials」，再退回凭据文件 | ~/.claude/.credentials.json、~/.config/claude | %USERPROFILE%\.claude\          |
 * | Codex       | ~/.config/codex/auth.json、~/.codex/auth.json    | 同左                                         | 同左（%USERPROFILE% 下）        |
 * | OpenCode    | ~/.local/share/opencode/auth.json                | $XDG_DATA_HOME/opencode，缺省同左            | 同左（%USERPROFILE% 下）        |
 *
 * CLAUDE_CONFIG_DIR、CODEX_HOME、OPENCODE_DATA_DIR 设了就只认它（Claude 在 macOS 另查按目录派生的钥匙串项）。
 * Codex 存进系统钥匙串的登录不读：那一项只信任 codex 自己，别的进程读会弹授权框，服务在后台等不到人点。
 */

type Env = Readonly<Record<string, string | undefined>>;

const pathFor = (platform: Platform) => (platform === "win32" ? win32 : posix);

const nonEmpty = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** `~`、`~/x` 展开到主目录；其余原样。 */
export function expandHome(
  value: string,
  home: string,
  platform: Platform,
): string {
  if (value === "~") return home;
  const rest = /^~[\\/]/.test(value) ? value.slice(2) : undefined;
  return rest === undefined ? value : pathFor(platform).join(home, rest);
}

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** Claude Code 按 CLAUDE_CONFIG_DIR 派生的钥匙串服务名：原服务名 + 目录字面量 sha256 前 8 位。 */
export function scopedClaudeService(configDir: string): string {
  const hash = createHash("sha256")
    .update(configDir.replace(/\\/g, "/"))
    .digest("hex");
  return `${CLAUDE_KEYCHAIN_SERVICE}-${hash.slice(0, 8)}`;
}

export function claudeSources(
  platform: Platform,
  home: string,
  env: Env,
): CredentialSource[] {
  const path = pathFor(platform);
  const configDir = nonEmpty(env.CLAUDE_CONFIG_DIR);
  const dirs = configDir
    ? [expandHome(configDir, home, platform)]
    : platform === "linux"
      ? [
          path.join(home, ".claude"),
          path.join(
            nonEmpty(env.XDG_CONFIG_HOME) ?? path.join(home, ".config"),
            "claude",
          ),
        ]
      : [path.join(home, ".claude")];
  const files: CredentialSource[] = dirs.map((dir) => ({
    kind: "file",
    path: path.join(dir, ".credentials.json"),
  }));
  if (platform !== "darwin") return files;
  const services = configDir
    ? [scopedClaudeService(configDir), CLAUDE_KEYCHAIN_SERVICE]
    : [CLAUDE_KEYCHAIN_SERVICE];
  const user = nonEmpty(env.USER) ?? nonEmpty(env.LOGNAME);
  const accounts = user ? [user, ""] : [""];
  const keychain: CredentialSource[] = services.flatMap((service) =>
    accounts.map((account) => ({
      kind: "keychain" as const,
      service,
      account,
    })),
  );
  // macOS 上 Claude Code 把登录写进钥匙串；凭据文件只是旧版本或手工迁移留下的，排在后面。
  return [...keychain, ...files];
}

export function codexSources(
  platform: Platform,
  home: string,
  env: Env,
): CredentialSource[] {
  const path = pathFor(platform);
  const codexHome = nonEmpty(env.CODEX_HOME);
  if (codexHome)
    return [
      {
        kind: "file",
        path: path.join(expandHome(codexHome, home, platform), "auth.json"),
      },
    ];
  return [
    { kind: "file", path: path.join(home, ".config", "codex", "auth.json") },
    { kind: "file", path: path.join(home, ".codex", "auth.json") },
  ];
}

export function opencodeSources(
  platform: Platform,
  home: string,
  env: Env,
): CredentialSource[] {
  const path = pathFor(platform);
  const configured = nonEmpty(env.OPENCODE_DATA_DIR);
  const xdg = nonEmpty(env.XDG_DATA_HOME);
  const dir = configured
    ? expandHome(configured, home, platform)
    : xdg
      ? path.join(expandHome(xdg, home, platform), "opencode")
      : path.join(home, ".local", "share", "opencode");
  return [{ kind: "file", path: path.join(dir, "auth.json") }];
}
