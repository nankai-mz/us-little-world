import { buildWebServer } from "./web-server-build.mjs";
import { mkdir } from "node:fs/promises";

await mkdir("artifacts/private-web", { recursive: true });
await buildWebServer("artifacts/private-web/server.mjs");
await import("../artifacts/private-web/server.mjs");
