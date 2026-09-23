import { createServer } from "node:http";

const server = createServer((request, response) => {
  response.writeHead(request.url === "/healthz" ? 200 : 404);
  response.end(request.url === "/healthz" ? "ok\n" : "not found\n");
});

server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => {
  process.stderr.write("owned fixture deliberate runtime crash\n");
  process.exit(42);
});
