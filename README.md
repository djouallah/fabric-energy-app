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
  return OneLake **user-delegation SAS** tokens: read-only on the `data/` folder (`getDataSas`), and
  create/write on one query-log CSV (`getLogUploadUrl`). The browser never holds a storage token. SAS
  last ~55 min and are cached (the data SAS in localStorage across reloads), so a visitor calls the
  functions about once an hour. Plain HTTPS fetch — no `azure` DuckDB extension.

```
browser (DuckDB-WASM)  ──fetch data/<file>?<SAS>──►  OneLake (data/ folder, read-only)
        ▲
        └── Rayfin Fabric SSO → getDataSas function (app identity token stays here) → folder SAS
```

## Setup

You need a Fabric workspace with a lakehouse:

- Workspace settings → OneLake → turn on **Authenticate with OneLake user-delegated SAS tokens** (off by
  default; the tenant setting *Use short-lived user-delegated SAS tokens* is on by default).
- The owner of the Fabric app item must be able to read the lakehouse and write `query_logs/` — the SAS
  can never exceed that identity's permissions.
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

## limitations

- **Users see the SAS** (DevTools): read-only on `data/` (keep only public data there) or create/write
  on one query-log CSV, ~55 min. Per-user OneLake permissions don't apply.
- **Single-threaded** DuckDB-WASM in `rayfin` mode. Multi-threading needs cross-origin isolation
  (COOP/COEP): the Fabric portal iframe can never be isolated, and COOP severs the Fabric sign-in popup.
- No data is committed here; it lives in your OneLake. No secrets are committed.
- **File format:** we use DuckDB's native `.duckdb` format for performance. Parquet files over HTTPS are also supported by DuckDB-WASM, and Iceberg is supported too — but the `azure` extension's `abfss://` scheme does not work in WASM, so OneLake access goes through plain HTTPS fetch with a Bearer token (as done here) rather than native Azure filesystem URIs.
- Want it without a sign-in? Set `oneLakeBase: ""` in `config.js` and put `data.duckdb` at `site/data/data.duckdb`
  so it's served same-origin (no token needed). Handy for a quick local check of query changes — but don't
  commit it (`*.duckdb` is gitignored).

## Why Rayfin and not GitHub Pages?

GitHub Pages is free and would serve the static files just fine — but it's public. Anyone on the internet can reach it. Rayfin gives you **Entra authentication out of the box**: only users in your tenant can open the app at all, with no extra infrastructure, no Azure AD App Proxy, and no custom auth middleware. One `rayfin up` and the app is tenant-gated.
