# AGENTS.md

Guide for an agent working on this repo or reproducing it elsewhere. Humans: see `README.md`.

## What this is

A dashboard hosted as a Microsoft Fabric app (Rayfin). There is no query service: a scheduled job
turns Apache Iceberg tables into a few DuckDB files in a OneLake lakehouse, and the browser queries
those files itself with DuckDB-WASM. Fabric supplies hosting, sign-in and a short-lived read-only
SAS for the data folder.

Diagram: `architecture.svg` (shown in the README); `architecture.excalidraw` is the editable copy.

```
Iceberg catalog (OneLake, source tenant)
        │ read (OIDC, app CATALOG_*)
        ▼
GitHub Actions: import_iceberg.py  ── DuckDB builds dim/today/agg/data .duckdb on the runner
        │ upload (OIDC, app LAKE_*), latest.txt last
        ▼
OneLake lakehouse (Fabric tenant): <workspace>/<lakehouse>.Lakehouse/Files/data
        ▲
        │ HTTPS GET / Range, URL signed with the SAS
Browser: site/index.html (DuckDB-WASM + ECharts)
        ▲ page, Fabric sign-in, SAS
        │
Fabric app (Rayfin): static hosting + function getDataSas (storage token never leaves the server)
```

## Files

| Path | Role |
|---|---|
| `import_iceberg.py` | The whole import: read catalog, build files, upload. Constants at the top. |
| `.github/workflows/import_data.yml` | Runs the import daily and on manual dispatch. |
| `site/index.html` | Dashboard. Vendored from `djouallah/analytics-as-code` `dashboard/index.html`; local changes are marked `FABRIC`. |
| `site/data.js` | DuckDB-WASM startup, file download + OPFS cache, SAS injection in the worker, remote attach. |
| `site/auth.js` | Fabric sign-in (Rayfin client) and the cached SAS. |
| `site/perflog.js`, `site/logs.js` | In-page Logs tab: timings of fetches, attaches, queries. |
| `rayfin/functions/src/function_app.ts` | `getDataSas`: signs a read-only directory SAS for `Files/data`. |
| `rayfin/rayfin.yml` | Fabric app config: static hosting of `dist/`, functions on, secret `ONELAKE_FILES_URL`. |
| `build.mjs` | Copies `site/` to `dist/` and stamps `__BUILD__`. No bundler. |

## Data contract (what the dashboard SQL expects)

`latest.txt` holds the name `data_<ts>.duckdb`. The other files share its `<ts>`.

| File | Attached as | Tables | Read how |
|---|---|---|---|
| `dim_<ts>.duckdb` | `dim` | `dim_calendar(date, year, month)`, `dim_duid(DUID, Region, FuelSourceDescriptor, ...)` | downloaded whole at start |
| `today_<ts>.duckdb` | `today` | `scada_today(DUID, date, time, mw)`, `price_today(REGIONID, date, time, price, demand, net_interchange)`, `interconnector_today` (last 14 days, 5-minute rows) | downloaded whole at start |
| `agg_<ts>.duckdb` | `agg` | `scada_daily`, `price_daily`, `scada_hourly`, `price_hourly`, `month_days` | downloaded whole after first paint |
| `data_<ts>.duckdb` | `history` | `scada`, `price`: all 5-minute history, sorted by `date` | attached over HTTP, Range reads, only when a 5-minute range starts before the `today` file |

`time` is HHMM as SMALLINT. The page builds four views over these (`v_scada`, `v_price`,
`v_scada_daily`, `v_price_daily`) in `refreshViews()`; every chart reads the views.

## Reproduce it

Prerequisites: a Fabric workspace with a lakehouse, an Iceberg catalog readable through the OneLake
Iceberg REST endpoint, a GitHub repo, Node, the Rayfin CLI (`npm install`).

1. **Point the import at your data.** In `import_iceberg.py` set `WAREHOUSE`
   (`<workspace id>/<lakehouse id>` of the catalog), `WORKSPACE` and `FOLDER` (target lakehouse),
   and `SOURCES`. Keep the output table names in the contract above, or change the SQL in
   `site/index.html` to match.
2. **Identities, no secrets.** Create (or reuse) one Entra app registration per tenant:
   - catalog tenant: read access to the source workspace;
   - Fabric tenant: Contributor on the target workspace.
   On each, add a federated credential: issuer `https://token.actions.githubusercontent.com`,
   audience `api://AzureADTokenExchange`, subject `<prefix>:ref:refs/heads/main` where `<prefix>`
   comes from `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` (`sub_claim_prefix`).
   The prefix changes form after a repo rename; always read it, never guess it.
3. **Repo variables:** `CATALOG_TENANT_ID`, `CATALOG_CLIENT_ID`, `LAKE_TENANT_ID`, `LAKE_CLIENT_ID`.
4. **Fabric app.** `npx rayfin login`, then `npm run rayfin:up`. In the workspace settings turn on
   "Authenticate with OneLake user-delegated SAS tokens". Then set the secret:
   `echo https://onelake.dfs.fabric.microsoft.com/<ws>/<lh>.Lakehouse/Files | npx rayfin secret set ONELAKE_FILES_URL --stdin`
   and run `npm run rayfin:up` again.
5. **Fill the lakehouse:** `gh workflow run import_data.yml`. A full run is about 6 minutes for
   160 M rows.
6. **Open** the hosting URL printed by `rayfin up`.

## Rules that are easy to break

- The browser never receives a storage token, only the SAS from `getDataSas` (read-only, one
  folder, about 55 minutes). Extend that function for new data access; do not expose a token.
- Files are immutable and named by timestamp. `latest.txt` is written last. Two versions of each
  file are kept so open pages keep working. Never overwrite a file a page may have attached.
- The history file is attached by a URL without the SAS; a shim in the DuckDB worker appends the
  current SAS to each request. Do not put the SAS in the attached URL: it expires.
- Do not name a DuckDB attach alias `full`: it is a SQL keyword. The history alias is `history`.
- `import_iceberg.py` writes the files with `STORAGE_VERSION 'v1.4.0'` so the browser's
  DuckDB-WASM can open them whatever DuckDB version runs the import.
- `data_<ts>.duckdb` must stay sorted by `date`: that is what makes a date-range query a few
  Range reads instead of a scan of the whole file.
- `site/index.html` is vendored. Keep local edits small and marked `FABRIC`; the header comment
  has the command that applies upstream changes.
- DuckDB-WASM runs single-threaded on purpose: cross-origin isolation breaks the sign-in popup.
- `README.md` is the public pitch: it must not mention DuckDB, WASM or SAS.

## Check your work

- Import: the workflow log prints a row count and date range per table, then `uploaded ...` for
  four files and `published (...)`.
- Page: sign in, default view renders; pick a range over 30 days (daily tables); pick a 5-minute
  range older than 14 days (history attach). The Logs tab shows the build stamp, each fetch,
  attach and query, and the worker's Range reads.
- After changing anything under `site/` or `rayfin/`: `npm run rayfin:up`.

## Rayfin agent context

This project ships Rayfin agent context.
Load `.agents/skills/rayfin/SKILL.md` and the `rayfin` MCP server in `.mcp.json` before writing Rayfin code.

Rayfin docs are version-locked to the packages installed in this project.
Prefer the MCP tools `search_docs`, `get_doc`, `list_docs`, and `discover_packages` for examples, API details, and troubleshooting.
If MCP is unavailable, run `rayfin docs ...` from the project root so the CLI reads this project's `node_modules`.
If `rayfin` is not on `PATH`, use `npx -y @microsoft/rayfin-cli docs ...` from the project root.

Use `discover_packages` or `rayfin docs discover <topic>` when installed docs do not cover the task.
