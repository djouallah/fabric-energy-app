// Static "build" for the Fabric dashboard: publish the contents of site/ to dist/.
// The dashboard is plain HTML + DuckDB-WASM (loaded from CDN) reading its .duckdb from OneLake —
// no bundler, so we just copy site/ -> dist/.
import { rm, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("./dist/", import.meta.url));
const site = fileURLToPath(new URL("./site/", import.meta.url));

await rm(dist, { recursive: true, force: true });
await cp(site, dist, { recursive: true });
console.log("Published site/ -> dist/");
