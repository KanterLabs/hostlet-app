import { createServer } from "node:http";
createServer((request, response) => { response.writeHead(request.url === "/healthz" ? 503 : 200); response.end(request.url === "/healthz" ? "not ready\n" : "candidate must not promote\n"); }).listen(Number(process.env.PORT || 3000), "0.0.0.0");
