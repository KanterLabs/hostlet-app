import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";

function rawPathStatus(port, path, signal, host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers: { Host: host },
      agent: false,
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    }, (response) => {
      const status = response.statusCode;
      response.destroy();
      resolve(status);
    });
    request.once("error", reject);
    request.end();
  });
}

export async function probeStaticHttpBoundary(port, slug, signal, evidence = {}) {
  const validHost = `127.0.0.1:${port}`;
  const invalidHost = "evil.example.test";
  const publishedPath = `/${slug}/`;
  evidence.target = validHost;
  evidence.published_path = publishedPath;
  evidence.valid_host = validHost;
  evidence.invalid_host = invalidHost;
  evidence.valid_host_status = await rawPathStatus(port, publishedPath, signal, validHost);
  evidence.invalid_host_status = await rawPathStatus(port, publishedPath, signal, invalidHost);
  evidence.unknown_slug_status = await rawPathStatus(port, `/m3-unknown-${randomUUID().slice(0, 8)}/`, signal, validHost);
  evidence.encoded_separator_status = await rawPathStatus(port, `/${slug}/assets%2Fsite.css`, signal, validHost);
  evidence.encoded_traversal_status = await rawPathStatus(port, `/${slug}/%2e%2e/${slug}/index.html`, signal, validHost);
  return evidence;
}

export function staticHttpBoundaryPassed(evidence) {
  return evidence.valid_host_status === 200 &&
    [400, 404].includes(evidence.invalid_host_status) &&
    evidence.unknown_slug_status === 404 &&
    evidence.encoded_separator_status === 404 &&
    evidence.encoded_traversal_status === 404;
}
