import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const backend = `http://127.0.0.1:${process.env.ATRIUM_PORT ?? 4310}`;
export default defineConfig({
  plugins: [react()],
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
