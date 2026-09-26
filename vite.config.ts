import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { stampWebDist } from "./server/web-dist.ts";
const backend = `http://127.0.0.1:${process.env.ATRIUM_PORT ?? 4310}`;

// 构建完成时把源码与产物内容指纹写进 dist，启动时用它判断是否过期。
// release.yml 用 git add -f dist 把指纹一起提交，发版产物自带指纹。
function sourceStamp(): Plugin {
  let root = process.cwd();
  return {
    name: "atrium-web-source-stamp",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    closeBundle() {
      stampWebDist(root);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), sourceStamp()],
  server: {
    host: "127.0.0.1",
    proxy: {
      // Preserve the browser-facing Host so the backend's Origin check remains valid.
      "/api": { target: backend, changeOrigin: false },
      "/mcp": { target: backend, changeOrigin: false },
      "/webhooks": { target: backend, changeOrigin: false },
      "/bridge": { target: backend, changeOrigin: false, ws: true },
    },
  },
});
