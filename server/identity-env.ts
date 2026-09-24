import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Variables describing the *calling Pi session*, not the service or a new identity. */
export const identityScopedVariables = [
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_CODING_AGENT",
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  "PI_MODEL",
  "PI_PROVIDER",
  "PI_REASONING_LEVEL",
  "PI_MCP_TOOL_EXPOSURE",
] as const;

const canonical = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** Database paths matter for identities moved outside the usual Pi home. */
export function identityEnvironmentContext(
  env: NodeJS.ProcessEnv,
  piHome = env.ATRIUM_PI_HOME ?? join(homedir(), ".pi"),
  identityDirectories: readonly string[] = [],
) {
  let candidate: string | undefined;
  try {
    if (
      env.PI_CODING_AGENT_DIR &&
      statSync(env.PI_CODING_AGENT_DIR).isDirectory()
    )
      candidate = canonical(env.PI_CODING_AGENT_DIR);
  } catch {
    // An absent or broken path is not evidence of an Atrium identity.
  }
  return {
    candidate,
    root: canonical(join(piHome, "atrium", "agents")),
    directories: identityDirectories.map(canonical),
  };
}

/** No I/O: the same decision runs in CLI and service after resolving symlinks. */
export function cleanIdentityEnvironment(
  env: NodeJS.ProcessEnv,
  context: ReturnType<typeof identityEnvironmentContext>,
): { env: NodeJS.ProcessEnv; ignored: string[] } {
  const result = { ...env };
  const path = context.candidate;
  if (!path) return { env: result, ignored: [] };
  const within = relative(context.root, path);
  const underRoot =
    within !== "" &&
    !within.startsWith(`..${sep}`) &&
    within !== ".." &&
    !isAbsolute(within) &&
    within.split(sep).length === 1;
  if (!underRoot && !context.directories.includes(path))
    return { env: result, ignored: [] };
  const ignored: string[] = [];
  for (const key of identityScopedVariables) {
    if (result[key] === undefined) continue;
    ignored.push(key);
    delete result[key];
  }
  return { env: result, ignored };
}

export function templateChoice(env: NodeJS.ProcessEnv) {
  if (env.ATRIUM_PI_TEMPLATE !== undefined)
    return {
      path: resolve(env.ATRIUM_PI_TEMPLATE),
      source: "ATRIUM_PI_TEMPLATE",
    };
  if (env.PI_CODING_AGENT_DIR !== undefined)
    return {
      path: resolve(env.PI_CODING_AGENT_DIR),
      source: "PI_CODING_AGENT_DIR",
    };
  return { path: resolve(homedir(), ".pi/agent"), source: "默认" };
}
