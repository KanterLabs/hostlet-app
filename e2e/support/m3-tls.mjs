import { X509Certificate, createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A run-owned TLS identity. Trust is limited to this certificate and hostname. */
export async function prepareM3Tls(context) {
  context.registerFixture("M3 owned TLS identity preparation", "e2e/support/m3-tls.mjs");
  const directory = join(context.tempDir, "owned-tls");
  mkdirSync(directory, { mode: 0o700 });
  const hostname = `demo-${randomUUID()}.localowned.test`;
  const certificate = join(directory, "certificate.pem");
  const privateKey = join(directory, "private-key.pem");
  const generated = await context.runCommand("Create owned local TLS identity", "openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
    "-subj", `/CN=${hostname}`, "-addext", `subjectAltName=DNS:${hostname}`,
    "-keyout", privateKey, "-out", certificate,
  ], {
    env: { PATH: process.env.PATH, LANG: "C" },
    timeoutMs: 30_000,
    logName: "m3-owned-tls-create.log",
  });
  if (generated.code !== 0) throw new Error("owned TLS certificate generation failed");
  chmodSync(privateKey, 0o600);
  chmodSync(certificate, 0o600);
  const x509 = new X509Certificate(readFileSync(certificate));
  if (x509.checkHost(hostname) !== hostname) throw new Error("owned certificate hostname mismatch");
  const spki = createHash("sha256")
    .update(x509.publicKey.export({ type: "spki", format: "der" })).digest("base64");
  copyFileSync(certificate, join(context.artifactDir, "m3-owned-tls-certificate.pem"));
  chmodSync(join(context.artifactDir, "m3-owned-tls-certificate.pem"), 0o600);
  context.state.configuration.m3Tls = {
    hostname, address: "127.0.0.1", certificateSha256: context.fileSha256(certificate),
    spkiSha256Base64: spki, trust: "exact owned certificate; no global certificate bypass",
    privateKeyRetained: false,
  };
  return Object.freeze({ hostname, certificate, privateKey, spki });
}
