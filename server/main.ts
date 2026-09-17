import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.ATRIUM_PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("ATRIUM_PORT 必须为有效端口");
const { app } = await createApp({
  data: resolve(process.env.ATRIUM_DATA ?? `${root}.atrium`),
  githubSecret: process.env.ATRIUM_GITHUB_SECRET,
  webRoot: `${root}dist`,
});
await app.listen({ port, host: "127.0.0.1" });
console.log(`Atrium → http://127.0.0.1:${port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
