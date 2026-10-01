# rayfin-duckdb-wasm

An experiment showing that you can run a **DuckDB-WASM** dashboard on **Microsoft Fabric** via
[Rayfin](https://www.npmjs.com/package/@microsoft/rayfin-cli) static hosting, and have the browser read
its data **directly from OneLake** — no backend, no server-side query layer.

![Dashboard screenshot](screenshots.png)

The sample dashboard is the [NemTracker](https://nemtracker.github.io/) Australian
energy-market app (ECharts + DuckDB-WASM). All it does is download a single consolidated `data.duckdb`
into the browser (OPFS) and query it with DuckDB-WASM; here that file is served from OneLake instead of
from the app's own origin.

## How it works

- **Hosting:** `build.mjs` copies `site/` → `dist/`, and `rayfin up` deploys `dist/` to Fabric static
  hosting. No bundler — the dashboard is a single `site/index.html` that loads ECharts, DuckDB-WASM and
  the Rayfin client from a CDN.
- **Data:** the dashboard reads one `data.duckdb` (~440 MB) from `<oneLakeBase>/data/data.duckdb` over HTTPS,
  downloads it whole into OPFS, and ATTACHes it. OneLake serves it with permissive **CORS** and honors
  **ETag / conditional GETs**, so an unchanged file is a `304` (reuse the OPFS copy). Because the file is
  **live** (regenerated every few minutes), most refreshes change the ETag and **re-download the whole
  ~440 MB** — an accepted trade-off for keeping everything in a single file. The dashboard also has no
  pre-aggregated daily tables in the file, so it **materializes small daily rollups once at load** to keep
  wide-range (daily-grain) charts fast over the 45 M-row 5-min fact.
- **Auth:** the browser signs in with **Rayfin's Fabric SSO** (no extra login; inside the Fabric portal
  iframe the session is handed over by `postMessage`) and calls Rayfin Functions
  (`rayfin/functions/src/function_app.ts`). They hold the app identity's OneLake token **server-side** and
  return a OneLake **user-delegation SAS**, read-only on the `data/` folder (`getDataSas`). The browser
  never holds a storage token. The SAS lasts ~55 min and is cached in localStorage across reloads, so a
  visitor calls the function about once an hour. Plain HTTPS fetch — no `azure` DuckDB extension.

```
browser (DuckDB-WASM)  ──fetch data/<file>?<SAS>──►  OneLake (data/ folder, read-only)
        ▲
        └── Rayfin Fabric SSO → getDataSas function (app identity token stays here) → folder SAS
```

## Setup

You need a Fabric workspace with a lakehouse:

- Workspace settings → OneLake → turn on **Authenticate with OneLake user-delegated SAS tokens** (off by
  default; the tenant setting *Use short-lived user-delegated SAS tokens* is on by default).
- The owner of the Fabric app item must be able to read the lakehouse — the SAS can never exceed that
  identity's permissions.
- After the first `rayfin up`, store the lakehouse Files URL as a Rayfin secret:
  `echo https://onelake.dfs.fabric.microsoft.com/<ws>/<lh>.Lakehouse/Files | npx rayfin secret set ONELAKE_FILES_URL --stdin`
- `cp site/config.example.js site/config.js` (`auth: "rayfin"` needs no ids — they come from the
  `rayfin.config.json` that `rayfin up` writes).

Everything else is Rayfin — see the [Rayfin documentation](https://learn.microsoft.com/fabric/embedded/rayfin/overview) for full details:

```bash
rayfin login      # sign in to Fabric
rayfin up         # build (build.mjs) + deploy dist/ to Fabric static hosting; prints the hosting URL
```

`rayfin.yml` is already wired (`data.enabled: false`, `functions.enabled: true`,
`staticHosting.buildCommand: npm run build:fabric`), so it's just `rayfin up`. Upload your `data.duckdb`
to `<oneLakeBase>/data/data.duckdb` in the lakehouse (the dashboard fetches it from exactly that path).
Open it inside the Fabric portal or in its own tab (one Fabric sign-in click there).

