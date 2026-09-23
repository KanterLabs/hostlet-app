import { open, statfs } from "node:fs/promises";

const BLOCK_BYTES = 16 * 1024 * 1024;
const FOUR_GIB = 4 * 1024 * 1024 * 1024;
// Keep each write bounded and cap an accidentally over-sized local workspace.
// The normal M3 profile gives the guest a 4 GiB ext4 workspace, so this cap is
// reached only if the filesystem fails to report ENOSPC at the intended bound.
const block = Buffer.alloc(BLOCK_BYTES, 0xa5);
const file = await open(new URL("./workspace-pressure.bin", import.meta.url), "wx");
let written = 0;
let observedEnospc = false;
try {
  while (written < FOUR_GIB + BLOCK_BYTES) {
    const remaining = FOUR_GIB + BLOCK_BYTES - written;
    const { bytesWritten } = await file.write(block.subarray(0, Math.min(block.length, remaining)));
    if (!bytesWritten) break;
    written += bytesWritten;
  }
} catch (error) {
  if (error?.code !== "ENOSPC") throw error;
  observedEnospc = true;
} finally {
  try { await file.close(); } catch (error) { if (error?.code !== "ENOSPC") throw error; }
}
if (!observedEnospc) throw new Error("workspace pressure ended without ENOSPC");
process.stderr.write(`owned fixture observed workspace ENOSPC after ${written} bytes\n`);
const capacity = await statfs(new URL(".", import.meta.url));
process.stderr.write(`owned workspace capacity block_size=${capacity.bsize} free_blocks=${capacity.bfree} available_blocks=${capacity.bavail} free_inodes=${capacity.ffree}\n`);
process.exitCode = 73;
