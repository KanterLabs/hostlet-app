import { cp, mkdir, rm } from "node:fs/promises";

await rm(new URL("./dist", import.meta.url), { recursive: true, force: true });
await mkdir(new URL("./dist", import.meta.url), { recursive: true });
await cp(new URL("./src/server.mjs", import.meta.url), new URL("./dist/server.mjs", import.meta.url));
await cp(new URL("../../migrations", import.meta.url), new URL("./dist/migrations", import.meta.url), { recursive: true });
