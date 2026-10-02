// Static "build" for the Fabric dashboard: publish the contents of site/ to dist/.
// The dashboard is plain HTML + DuckDB-WASM (loaded from CDN) reading its .duckdb from OneLake —
// no bundler, so we just copy site/ -> dist/ and stamp __BUILD__ (git sha + time) into the files,
// so the Logs tab can tell a fresh deploy from a cached one.
import { rm, cp, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const dist = fileURLToPath(new URL("./dist/", import.meta.url));
const site = fileURLToPath(new URL("./site/", import.meta.url));

const git = (cmd) => { try { return execSync(`git ${cmd}`, { encoding: "utf8" }).trim(); } catch { return ""; } };
const sha = git("rev-parse --short HEAD") || "unknown";
const dirty = git("status --porcelain -- site build.mjs") ? "-dirty" : "";
// URL-safe (it is also used as the ?v= cache-buster on the module imports): <sha>.<yyyymmdd-hhmm UTC>
const BUILD = `${sha}${dirty}.${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13)}`;

await rm(dist, { recursive: true, force: true });
await cp(site, dist, { recursive: true });
for (const f of await readdir(dist, { recursive: true })) {
  if (!/\.(html|js)$/.test(f)) continue;
  const p = dist + f;
  const s = await readFile(p, "utf8");
  if (s.includes("__BUILD__")) await writeFile(p, s.replaceAll("__BUILD__", BUILD));
}
console.log(`Published site/ -> dist/ (build ${BUILD})`);
