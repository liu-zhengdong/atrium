import { spawnSync } from "node:child_process";

export type ContainerVerdict = "alive" | "exited" | "unknown";
type InspectResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};
type Inspect = (id: string) => InspectResult;

function dockerInspect(id: string): InspectResult {
  const result = spawnSync(
    "docker",
    ["inspect", id, "--format", "{{json .State}}"],
    {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 2048,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

/** A local PID is not proof about a detached Docker container. Missing Docker is unknown. */
export function containerWriterVerdict(
  containerId: string | undefined,
  inspect: Inspect = dockerInspect,
): ContainerVerdict {
  if (!containerId || !/^[a-f0-9]{64}$/.test(containerId)) return "unknown";
  const result = inspect(containerId);
  if (result.error) return "unknown";
  if (result.status !== 0)
    return result.status === 1 &&
      new RegExp(`^error: no such object: ${containerId}\\s*$`, "i").test(
        result.stderr,
      )
      ? "exited"
      : "unknown";
  try {
    const state = JSON.parse(result.stdout) as {
      Running?: unknown;
      Status?: unknown;
    };
    if (state.Running === true) return "alive";
    if (
      state.Running === false &&
      ["exited", "dead"].includes(String(state.Status))
    )
      return "exited";
  } catch {
    /* malformed inspect is not proof of exit */
  }
  return "unknown";
}

/** Claim a successor only after the old container is proved stopped. */
export function mayReplaceContainerWriter(
  containerId: string | undefined,
  inspect: Inspect = dockerInspect,
) {
  return containerWriterVerdict(containerId, inspect) === "exited";
}
