import { createServer } from "node:http";
const server = createServer((request, response) => {
  const payload = JSON.stringify({ status: request.url === "/healthz" ? "ok" : "ready", node: process.versions.node, fixture: "node22-api" });
  response.writeHead(request.url === "/healthz" || request.url === "/" ? 200 : 404, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  response.end(payload);
});
server.listen(Number(process.env.PORT || 3000), "0.0.0.0");
