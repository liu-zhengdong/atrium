import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { templateChoice } from "../server/identity-env.ts";
import {
  reportDroppedIdentity,
  serviceEnvironment,
} from "../server/service-env.ts";

test("服务环境白名单只保留系统、网络与隔离变量，凭据与身份一律不传", () => {
  const base: NodeJS.ProcessEnv = {
    // 系统基本
    PATH: "/usr/bin",
    HOME: "/Users/x",
    USER: "x",
    LOGNAME: "x",
    SHELL: "/bin/zsh",
    TMPDIR: "/tmp",
    LANG: "zh_CN.UTF-8",
    LC_ALL: "zh_CN.UTF-8",
    TZ: "Asia/Shanghai",
    // Atrium 配置
    ATRIUM_PORT: "4347",
    ATRIUM_DATA: "/tmp/atrium",
    ATRIUM_PI_HOME: "/tmp/pi",
    // 隔离
    NPM_CONFIG_PREFIX: "/tmp/npm-prefix",
    npm_config_prefix: "/tmp/npm-prefix",
    PI_ACP_DIR: "/tmp/pi-acp",
    NODE_TEST_CONTEXT: "child-v8",
    // 网络
    HTTP_PROXY: "http://proxy:8080",
    HTTPS_PROXY: "http://proxy:8080",
    NO_PROXY: "localhost",
    ALL_PROXY: "socks5://proxy:1080",
    https_proxy: "http://proxy:8080",
    NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
    SSL_CERT_FILE: "/etc/ssl.pem",
    // 凭据与身份（必须不传）
    ANTHROPIC_API_KEY: "sk-ant",
    OPENAI_API_KEY: "sk-oai",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-tok",
    GH_TOKEN: "gh-tok",
    GITHUB_TOKEN: "gh-tok",
    PI_SESSION_FILE: "/tmp/session.jsonl",
    PI_CODING_AGENT_DIR: "/tmp/agent-dir",
    PI_ACP_PI_COMMAND: "/tmp/user-pi",
    SSH_AUTH_SOCK: "/tmp/ssh-agent",
    HERDR_SOCKET: "/tmp/herdr.sock",
    // 其余普通变量也不传，但不进回执
    SOMETHING_RANDOM: "x",
  };
  const { env, droppedSensitive } = serviceEnvironment(base);

  const keep = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TZ",
    "ATRIUM_PORT",
    "ATRIUM_DATA",
    "ATRIUM_PI_HOME",
    "NPM_CONFIG_PREFIX",
    "npm_config_prefix",
    "PI_ACP_DIR",
    "NODE_TEST_CONTEXT",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "https_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
  ];
  for (const key of keep) assert.equal(env[key], base[key], key);
  const drop = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "PI_SESSION_FILE",
    "PI_CODING_AGENT_DIR",
    "PI_ACP_PI_COMMAND",
    "SSH_AUTH_SOCK",
    "HERDR_SOCKET",
    "SOMETHING_RANDOM",
  ];
  for (const key of drop) assert.equal(env[key], undefined, key);

  // 回执只含凭据/身份类，按名排序；普通被丢变量不提。
  assert.deepEqual(droppedSensitive, [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "HERDR_SOCKET",
    "OPENAI_API_KEY",
    "PI_ACP_PI_COMMAND",
    "PI_CODING_AGENT_DIR",
    "PI_SESSION_FILE",
    "SSH_AUTH_SOCK",
  ]);
  // 输入环境不被修改。
  assert.equal(base.ANTHROPIC_API_KEY, "sk-ant");
});

test("回执打印一行变量名，不打印值", () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string) => lines.push(line);
  try {
    reportDroppedIdentity([]);
    reportDroppedIdentity(["GH_TOKEN", "SSH_AUTH_SOCK"]);
  } finally {
    console.error = original;
  }
  assert.deepEqual(lines, [
    "已忽略身份/凭据环境变量：GH_TOKEN, SSH_AUTH_SOCK；身份只用分配的账号。",
  ]);
  assert.ok(
    lines.every((line) => !line.includes("=")),
    "不打印任何值",
  );
});

test("模板选择：ATRIUM_PI_TEMPLATE 优先，其次 PI_CODING_AGENT_DIR，默认", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-identity-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const custom = join(root, "custom");
  const moved = join(root, "moved");
  mkdirSync(custom);
  mkdirSync(moved);
  assert.deepEqual(templateChoice({ PI_CODING_AGENT_DIR: custom }), {
    path: custom,
    source: "PI_CODING_AGENT_DIR",
  });
  assert.equal(templateChoice({}).source, "默认");
  assert.deepEqual(
    templateChoice({ ATRIUM_PI_TEMPLATE: moved, PI_CODING_AGENT_DIR: custom }),
    { path: moved, source: "ATRIUM_PI_TEMPLATE" },
  );
});
