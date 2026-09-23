import { createServer } from "node:http";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const releaseId = "api-v2";
const healthErrorCodes = new Set([
  "42P01", "42501", "28P01", "3D000", "08001", "08006", "57P03", "53300",
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EACCES",
]);

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
      const result = await pool.query("SELECT max(revision)::int AS revision FROM fixture_schema_migrations");
      json(response, 200, { status: "ok", release_id: releaseId, migration_revision: result.rows[0].revision });
    } else if (request.method === "GET" && request.url === "/api/release") {
      json(response, 200, { api_version: releaseId, compatible_clients: ["frontend-v1", "frontend-v2"] });
    } else if (request.method === "GET" && request.url === "/api/items") {
      const result = await pool.query("SELECT id, name, name AS title, detail, created_at FROM journal_items ORDER BY id");
      json(response, 200, { api_version: releaseId, items: result.rows });
    } else if (request.method === "POST" && request.url === "/api/items") {
      const input = await body(request);
      const title = typeof input.title === "string" ? input.title : input.name;
      if (typeof title !== "string" || title.trim().length === 0 || title.length > 80) return json(response, 422, { error: "invalid_name" });
      const result = await pool.query("INSERT INTO journal_items(name, detail, client_release) VALUES ($1, $2, $3) RETURNING id, name, name AS title, detail, created_at", [title.trim(), typeof input.detail === "string" ? input.detail.slice(0, 240) : "", typeof input.client_release === "string" ? input.client_release.slice(0, 40) : null]);
      json(response, 201, { api_version: releaseId, item: result.rows[0] });
    } else json(response, 404, { error: "not_found" });
  } catch (error) {
    const status = error.message === "body_too_large" ? 413 : 500;
    const diagnosticCode = healthErrorCodes.has(error?.code) ? error.code : "unknown";
    json(response, status, request.method === "GET" && request.url === "/healthz"
      ? { error: "request_failed", diagnostic_code: diagnosticCode }
      : { error: "request_failed" });
  }
});

server.listen(Number(process.env.PORT || 3000), "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => pool.end().finally(() => process.exit(0))));
