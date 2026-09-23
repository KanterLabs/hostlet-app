import { mkdir, open } from "node:fs/promises";
const bytes = 262_145_000;
await mkdir(new URL("./dist", import.meta.url), { recursive: true });
const file = await open(new URL("./dist/payload.bin", import.meta.url), "w");
try { await file.truncate(bytes); } finally { await file.close(); }
