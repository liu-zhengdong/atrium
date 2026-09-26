import { spawnSync } from "node:child_process";

export type ContainerVerdict = "alive" | "exited" | "unknown";
type InspectResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};
type Inspect = (id: string) => InspectResult;
export type ContainerOwner = {
  containerId: string;
  engineId: string;
  imageId: string;
  identityId: string;
  generation: string;
};
export type DockerCommand = (args: string[]) => InspectResult;

function dockerCommand(args: string[]): InspectResult {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 8192,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function dockerInspect(id: string): InspectResult {
  return dockerCommand(["inspect", id, "--format", "{{json .State}}"]);
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

/** A missing ID proves exit only on the same Docker engine that created it.
 * A found ID additionally needs the recorded identity, generation and image. */
export function ownedContainerVerdict(
  owner: ContainerOwner,
  command: DockerCommand = dockerCommand,
): ContainerVerdict {
  const { containerId, engineId, imageId, identityId, generation } = owner;
  if (
    !/^[a-f0-9]{64}$/.test(containerId) ||
    !engineId ||
    !/^sha256:[a-f0-9]{64}$/.test(imageId) ||
    !identityId ||
    !generation
  )
    return "unknown";
  const engine = command(["info", "--format", "{{.ID}}"]);
  if (engine.error || engine.status !== 0 || engine.stdout.trim() !== engineId)
    return "unknown";
  const inspection = command([
    "inspect",
    containerId,
    "--format",
    '{"state":{{json .State}},"labels":{{json .Config.Labels}},"image":{{json .Image}}}',
  ]);
  if (inspection.error || inspection.status !== 0)
    return containerWriterVerdict(containerId, () => inspection);
  try {
    const detail = JSON.parse(inspection.stdout) as {
      state?: unknown;
      labels?: Record<string, unknown>;
      image?: unknown;
    };
    if (
      detail.labels?.["atrium.identity"] !== identityId ||
      detail.labels["atrium.runner-generation"] !== generation ||
      detail.labels["atrium.image-id"] !== imageId ||
      detail.image !== imageId
    )
      return "unknown";
    return containerWriterVerdict(containerId, () => ({
      ...inspection,
      stdout: JSON.stringify(detail.state),
    }));
  } catch {
    return "unknown";
  }
}
