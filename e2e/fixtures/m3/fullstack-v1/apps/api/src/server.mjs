import { createServer } from "node:http";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const releaseId = "api-v1";

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": bytes.length, "Cache-Control": "no-store" });
  response.end(bytes);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      const result = await pool.query("SELECT current_database() AS database");
      json(response, 200, { status: "ok", release_id: releaseId, database: result.rows[0].database });
    } else if (request.method === "GET" && request.url === "/api/release") {
      json(response, 200, { api_version: releaseId, compatible_clients: ["frontend-v1", "frontend-v2"] });
    } else if (request.method === "GET" && request.url === "/api/items") {
      const result = await pool.query("SELECT id, name, created_at FROM journal_items ORDER BY id");
      json(response, 200, { api_version: releaseId, items: result.rows });
    } else if (request.method === "POST" && request.url === "/api/items") {
      const input = await body(request);
      if (typeof input.name !== "string" || input.name.trim().length === 0 || input.name.length > 80) return json(response, 422, { error: "invalid_name" });
      const result = await pool.query("INSERT INTO journal_items(name) VALUES ($1) RETURNING id, name, created_at", [input.name.trim()]);
      json(response, 201, { api_version: releaseId, item: result.rows[0] });
    } else json(response, 404, { error: "not_found" });
  } catch (error) {
    json(response, error.message === "body_too_large" ? 413 : 500, { error: "request_failed" });
  }
});

server.listen(Number(process.env.PORT || 3000), "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => pool.end().finally(() => process.exit(0))));
