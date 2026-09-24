import { execFile, spawn } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { Problem } from "./store.ts";

const require = createRequire(import.meta.url);
export const containerName = (id: string) =>
  `${process.env.ATRIUM_CONTAINER_PREFIX || "atrium-agent-"}${id}`;
const image = () => process.env.ATRIUM_CONTAINER_IMAGE || "atrium-agent:local";
const exec = promisify(execFile);
const docker = async (...args: string[]) =>
  (
    await exec("docker", args, { timeout: 10000, maxBuffer: 1024 * 1024 })
  ).stdout.trim();

export function validMounts(paths: string[]): string[] {
  if (paths.length > 12) throw new Problem(400, "最多授权 12 个目录");
  return paths
    .map((path) => {
      if (!isAbsolute(path)) throw new Problem(400, "授权目录须为绝对路径");
      let canonical: string;
      try {
        canonical = realpathSync(path);
      } catch {
        throw new Problem(400, `目录不存在：${path}`);
      }
      if (canonical === sep) throw new Problem(400, "不能挂载文件系统根目录");
      if (!statSync(canonical).isDirectory())
        throw new Problem(400, "只能授权目录，不支持挂载单个文件");
      return canonical;
    })
    .filter((path, index, all) => all.indexOf(path) === index);
}

/** Keep the host profile untouched. Only the settings file is mapped into container paths. */
export function containerSettings(
  directory: string,
  cwd: string,
  mounts: string[],
  data: string,
  id: string,
) {
  const source = JSON.parse(
    readFileSync(join(directory, "settings.json"), "utf8"),
  ) as unknown;
  const bundle = dirname(require.resolve("@liuser/pi-atrium/package.json"));
  const roots = [
    [directory, "/agent"],
    [cwd, "/workspace"],
    [bundle, "/usr/local/lib/node_modules/@liuser/pi-atrium"],
    ...mounts.map((path, index) => [path, `/mounts/${index + 1}`]),
  ];
  const map = (value: unknown): unknown => {
    if (typeof value === "string" && isAbsolute(value)) {
      const root = roots.find(
        ([host]) => value === host || value.startsWith(host + sep),
      );
      return root ? join(root[1], relative(root[0], value)) : value;
    }
    if (Array.isArray(value)) return value.map(map);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, map(item)]),
      );
    return value;
  };
  const target = join(data, "containers", id);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const file = join(target, "settings.json");
  writeFileSync(file, JSON.stringify(map(source), null, 2) + "\n", {
    mode: 0o600,
  });
  return file;
}

/** Fail closed on a pre-existing container; never replace or remove a container we did not start. */
export async function containerState(
  id: string,
): Promise<"absent" | "running" | "paused" | "stopped"> {
  try {
    const state = JSON.parse(
      await docker("inspect", "--format", "{{json .State}}", containerName(id)),
    ) as { Running: boolean; Paused: boolean };
    return state.Paused ? "paused" : state.Running ? "running" : "stopped";
  } catch (error) {
    if (
      /no such (?:object|container)/i.test(
        (error as { stderr?: string }).stderr ?? "",
      )
    )
      return "absent";
    throw error;
  }
}

export async function controlContainer(
  id: string,
  action: "pause" | "unpause" | "stop",
) {
  await docker(action, containerName(id));
}

export function spawnContainer(
  id: string,
  directory: string,
  cwd: string,
  mounts: string[],
  settings: string,
) {
  const args = [
    "run",
    "--rm",
    "--init",
    "-i",
    "--name",
    containerName(id),
    "--network",
    "bridge",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--mount",
    `type=bind,src=${directory},dst=/agent`,
    "--mount",
    `type=bind,src=${settings},dst=/agent/settings.json,readonly`,
    "--mount",
    `type=bind,src=${cwd},dst=/workspace`,
    ...mounts.flatMap((path, index) => [
      "--mount",
      `type=bind,src=${path},dst=/mounts/${index + 1}`,
    ]),
    "--env",
    "PI_CODING_AGENT_DIR=/agent",
    "--env",
    "PI_ACP_DIR=/agent/.pi-acp",
    "--env",
    "PI_MCP_TOOL_EXPOSURE=proxy-only",
    "--workdir",
    "/workspace",
    image(),
    "node",
    "/usr/local/lib/node_modules/@liuser/pi-atrium/dist/index.js",
  ];
  return spawn("docker", args, {
    stdio: "pipe",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
}

export function containerImageCommand() {
  return `docker build -t ${image()} -f containers/agent.Dockerfile .`;
}
export async function requireImage() {
  try {
    await docker("image", "inspect", image());
  } catch {
    throw new Problem(409, `容器镜像尚未构建：${containerImageCommand()}`);
  }
}
