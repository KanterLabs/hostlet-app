import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const controlPlane = "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/v1": { target: controlPlane, changeOrigin: true },
      "/readyz": { target: controlPlane, changeOrigin: true },
      "/healthz": { target: controlPlane, changeOrigin: true },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
