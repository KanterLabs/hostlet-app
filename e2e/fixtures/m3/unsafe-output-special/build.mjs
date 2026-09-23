import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

await mkdir(new URL("./dist", import.meta.url));
await writeFile(new URL("./dist/index.html", import.meta.url), "owned unsafe output sentinel\n");
// A disposable guest runs as root, so exercise a real device node when its
// policy permits mknod. Unprivileged or restricted guests use a FIFO fallback;
// both are rejected by the artifact collector as unsafe output entries.
const device = new URL("./dist/owned-output.device", import.meta.url);
const deviceResult = spawnSync("mknod", ["-m", "600", device.pathname, "c", "1", "7"], { stdio: "ignore" });
if (deviceResult.status === 0) {
  process.stderr.write("owned fixture created a device output entry\n");
} else {
  const fifo = new URL("./dist/owned-output.fifo", import.meta.url);
  const fifoResult = spawnSync("mkfifo", ["-m", "600", fifo.pathname], { stdio: "ignore" });
  if (fifoResult.error) throw fifoResult.error;
  if (fifoResult.status !== 0) throw new Error(`mkfifo failed with status ${fifoResult.status}`);
  process.stderr.write("owned fixture created a FIFO output entry\n");
}
