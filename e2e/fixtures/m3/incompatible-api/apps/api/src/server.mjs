import { createServer } from "node:http";

createServer((request, response) => {
  const ok = request.url === "/healthz";
  const body = JSON.stringify(ok ? { status: "ok", release_id: "api-v3-incompatible" } : { error: "v1_routes_removed" });
  response.writeHead(ok ? 200 : 410, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}).listen(Number(process.env.PORT || 3000), "0.0.0.0");
