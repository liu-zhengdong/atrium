import { createConnection } from "node:net";

/** A body-less raw POST that must receive its status before body parsing. */
export function declaredBodyWithoutBytes(
  port: number,
  path: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setTimeout(1500, () => {
      socket.destroy();
      reject(new Error(`${path}: authentication waited for the request body`));
    });
    socket.on("connect", () =>
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: atrium.localhost:${port}\r\nContent-Type: application/json\r\nContent-Length: 10485760\r\nConnection: close\r\n\r\n`,
      ),
    );
    socket.on("data", (chunk) => {
      response += chunk.toString();
      const status = /^HTTP\/1\.1 (\d+)/.exec(response)?.[1];
      if (status) {
        socket.destroy();
        resolve(Number(status));
      }
    });
    socket.on("error", reject);
    socket.on("close", () => {
      if (!response)
        reject(new Error(`${path}: connection closed without response`));
    });
  });
}
