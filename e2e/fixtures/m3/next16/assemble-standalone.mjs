import { cp, mkdir } from "node:fs/promises";
await mkdir(new URL("./.next/standalone/.next", import.meta.url), { recursive: true });
await cp(new URL("./.next/static", import.meta.url), new URL("./.next/standalone/.next/static", import.meta.url), { recursive: true });
await cp(new URL("./public", import.meta.url), new URL("./.next/standalone/public", import.meta.url), { recursive: true });
