// Static "build" for the Fabric dashboard: publish the contents of site/ to dist/.
// The dashboard is plain HTML + DuckDB-WASM (loaded from CDN) reading a single data.duckdb
// from OneLake (or same-origin when oneLakeBase="") — no bundler, so we just copy site/ -> dist/.
import { rm, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const dist = fileURLToPath(new URL("./dist/", import.meta.url));
const site = fileURLToPath(new URL("./site/", import.meta.url));
// site/data/ holds the bundled demo DB for the no-auth GitHub Pages build only; the Fabric build
// reads OneLake and must not ship a stale copy.
const demoData = resolve(site, "data");

await rm(dist, { recursive: true, force: true });
await cp(site, dist, { recursive: true, filter: (src) => resolve(src) !== demoData });
console.log("Published site/ -> dist/ (without site/data/)");
