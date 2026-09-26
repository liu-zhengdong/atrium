import { spawnSync } from "node:child_process";
import { Problem } from "./problem.ts";

/** Docker is optional for all default Pi identities; never probe it on their path. */
export function requireContainerImage(
  image: string,
  inspect: (digest: string) => {
    status: number | null;
    stdout: string;
    error?: Error;
  } = (digest) =>
    spawnSync("docker", ["image", "inspect", digest, "--format", "{{.Id}}"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 2048,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    }),
) {
  if (!image || !/^sha256:[a-f0-9]{64}$/.test(image))
    throw new Problem(
      409,
      "容器镜像未钉住，不能启动容器身份或改动插件",
      "container_unavailable",
    );
  const result = inspect(image);
  if (result.error || result.status !== 0 || result.stdout.trim() !== image)
    throw new Problem(
      409,
      "Docker 不可用或指定镜像不存在",
      "container_unavailable",
    );
  return image;
}
