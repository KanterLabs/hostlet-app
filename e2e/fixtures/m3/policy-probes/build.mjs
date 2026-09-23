import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";

const forbiddenPaths = ["/etc/hostlet-owner", "/var/run/docker.sock", "/run/containerd/containerd.sock"];
const forbiddenNetwork = [
  { name: "metadata-v4", host: "169.254.169.254", port: 80 },
  { name: "metadata-v6", host: "fd00:ec2::254", port: 80 },
  { name: "docker-v4", host: "127.0.0.1", port: 2375 },
  { name: "docker-v6", host: "::1", port: 2375 },
  { name: "tenant-control-v4", host: "192.0.2.10", port: 8080 },
  { name: "tenant-control-v6", host: "2001:db8::10", port: 8080 },
  { name: "runtime-control-v4", host: "192.0.2.11", port: 8080 },
  { name: "runtime-control-v6", host: "2001:db8::11", port: 8080 },
  { name: "tenant-database-v4", host: "192.0.2.12", port: 5432 },
  { name: "tenant-database-v6", host: "2001:db8::12", port: 5432 },
];

function tcpProbe(target) {
  return new Promise((resolve) => {
    const socket = connect({ host: target.host, port: target.port });
    const finish = (connected, code) => { socket.destroy(); resolve({ ...target, connected, code }); };
    socket.setTimeout(500, () => finish(false, "timeout"));
    socket.once("connect", () => finish(true, null));
    socket.once("error", (error) => finish(false, error.code || error.name));
  });
}

await rm(new URL("./dist", import.meta.url), { recursive: true, force: true });
await mkdir(new URL("./dist", import.meta.url), { recursive: true });
const network = [];
for (const target of forbiddenNetwork) network.push(await tcpProbe(target));
const paths = [];
for (const path of forbiddenPaths) {
  try { await readFile(path); paths.push({ path, readable: true, code: null }); }
  catch (error) { paths.push({ path, readable: false, code: error.code || error.name }); }
}
if (network.some(({ connected }) => connected) || paths.some(({ readable }) => readable)) {
  throw new Error("build_isolation_boundary_accessible");
}
await cp(new URL("./server.mjs", import.meta.url), new URL("./dist/server.mjs", import.meta.url));
await writeFile(new URL("./dist/build-isolation.json", import.meta.url), `${JSON.stringify({
  schema: "hostlet.owned-build-isolation/v1",
  network,
  paths,
})}\n`, { mode: 0o644 });
