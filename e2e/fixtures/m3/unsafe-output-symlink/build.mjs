import { mkdir, symlink, writeFile } from "node:fs/promises";

await mkdir(new URL("./real-output", import.meta.url));
await writeFile(new URL("./real-output/index.html", import.meta.url), "owned unsafe output sentinel\n");
await symlink("real-output", new URL("./dist", import.meta.url), "dir");
