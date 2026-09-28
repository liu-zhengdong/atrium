import { Problem } from "../problem.ts";

/** 连接配置只含地址和私钥路径，不保存私钥内容。 */
export type SshConnection = {
  target: string;
  key: string | null;
  localPort: number;
  remotePort: number;
};

const port = (value: number) =>
  Number.isInteger(value) && value >= 1 && value <= 65535;

export function tunnelPorts(value: string): {
  localPort: number;
  remotePort: number;
} {
  const match = /^([1-9][0-9]{0,4}):([1-9][0-9]{0,4})$/.exec(value);
  if (!match || !port(Number(match[1])) || !port(Number(match[2])))
    throw new Problem(
      400,
      "--tunnel 应为本机端口:远端端口，端口范围 1–65535",
      "usage",
    );
  return { localPort: Number(match[1]), remotePort: Number(match[2]) };
}

export function sshConnection(
  input: { ssh?: unknown; key?: unknown; tunnel?: unknown },
  servicePort?: number,
): SshConnection | null {
  if (
    input.ssh === undefined &&
    input.key === undefined &&
    input.tunnel === undefined
  )
    return null;
  if (
    typeof input.ssh !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/.test(
      input.ssh,
    ) ||
    input.ssh.includes("..")
  )
    throw new Problem(400, "--ssh 应为 user@地址（不含空格或选项）", "usage");
  if (
    input.key !== undefined &&
    (typeof input.key !== "string" ||
      !input.key.trim() ||
      /[\r\n\0]/.test(input.key) ||
      input.key.startsWith("-"))
  )
    throw new Problem(400, "--key 应为私钥文件路径", "usage");
  const ports =
    input.tunnel === undefined
      ? servicePort && port(servicePort)
        ? { localPort: servicePort, remotePort: servicePort }
        : null
      : typeof input.tunnel === "string"
        ? tunnelPorts(input.tunnel)
        : null;
  if (!ports) throw new Problem(400, "--tunnel 应为本机端口:远端端口", "usage");
  return {
    target: input.ssh,
    key: (input.key as string | undefined) ?? null,
    ...ports,
  };
}

export function tunnelArgs(
  connection: SshConnection,
  key: string | null,
): string[] {
  return [
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=yes",
    ...(key ? ["-o", "IdentitiesOnly=yes", "-i", key] : []),
    "-R",
    `127.0.0.1:${connection.remotePort}:127.0.0.1:${connection.localPort}`,
    connection.target,
  ];
}

export function retryDelay(attempt: number) {
  return Math.min(60_000, 1000 * 2 ** Math.min(6, Math.max(0, attempt)));
}
