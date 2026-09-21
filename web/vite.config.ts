import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

type HttpProxyFailureResponse = {
  req: unknown;
  headersSent: boolean;
  writableEnded: boolean;
  writeHead(status: number, headers: Record<string, string>): { end(body: string): void };
};

type ProxyFailureResponse = HttpProxyFailureResponse | { end(): void };

type ErrorAwareProxy = {
  on(
    event: "error",
    handler: (error: unknown, request: unknown, response: ProxyFailureResponse) => void,
  ): void;
};

function controlProxy(controlPlane: string): ProxyOptions {
  return {
    target: controlPlane,
    changeOrigin: true,
    configure(proxy) {
      (proxy as unknown as ErrorAwareProxy).on("error", (_error, _request, response) => {
        if ("req" in response && !response.headersSent && !response.writableEnded) {
          response
            .writeHead(502, { "Content-Type": "application/json" })
            .end(JSON.stringify({ status: "offline", reason: "control API upstream unavailable" }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const controlPlane =
    loadEnv(mode, ".", "VITE_CONTROL_PLANE").VITE_CONTROL_PLANE ?? "http://127.0.0.1:8080";

  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/v1": controlProxy(controlPlane),
        "/readyz": controlProxy(controlPlane),
        "/healthz": controlProxy(controlPlane),
      },
    },
    preview: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
    },
  };
});
