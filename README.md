# fabric-energy-app

An Australian energy market dashboard, built as a **Microsoft Fabric** app with
[Rayfin](https://www.npmjs.com/package/@microsoft/rayfin-cli). Fabric hosts the page and signs you
in, and the page reads its data **directly from OneLake** — no backend to run, no query service.

![Dashboard screenshot](screenshots.png)

It is the same dashboard as [NemTracker](https://nemtracker.github.io/), hosted on Fabric.

## How it works

![Architecture](architecture.svg)

- **Hosting:** `rayfin up` deploys the `site/` folder to Fabric static hosting.
- **Sign-in:** Fabric single sign-on. Inside the Fabric portal there is no extra login; in its own
  tab it is one click.
- **Data:** the dashboard's files live in a lakehouse, under `Files/data`. The browser reads them
  from OneLake itself, with read-only access to that one folder.
- **Refresh:** a GitHub workflow (`.github/workflows/import_data.yml`) rebuilds those files from
  the source catalog and uploads them to the lakehouse.

## Limitations

This is an experiment. Read these before you copy it:

- **No row-level or column-level security.** Access is all or nothing per table. The browser
  downloads the files, so anyone who can open the app can read every row and column in them. Fabric
  controls who can open the app and nothing finer. Do not use this for data that needs RLS or CLS.
- **The read access can be copied.** The browser holds read-only access to the data folder for up to
  an hour. A signed-in user can take it and download the files outside the app until it expires.
- **Single-threaded.** The query engine runs in the browser (WebAssembly) on one thread: a heavy
  query blocks until it finishes, and more cores do not help. This may change in the future.
- **Limited by the browser.** A tab gets about 4 GB of memory; a query that needs more fails. Phones
  and old laptops will struggle.
- **Not real time.** The data is rebuilt by a daily batch job, and each run rewrites all history.
- **Slower on old data.** The first visit downloads about 20 MB. Detailed history older than two
  weeks is read from OneLake over the network, query by query.
- **Every chart is code.** No self-service: no drag and drop, no measures, no shared semantic model.
  A change means editing the page.
- **Read-only.** There is no write-back.

## Setup

You need a Fabric workspace with a lakehouse:

- Workspace settings → OneLake → turn on **Authenticate with OneLake user-delegated SAS tokens** (off by
  default; the tenant setting *Use short-lived user-delegated SAS tokens* is on by default).
- The owner of the Fabric app item must be able to read the lakehouse.
- After the first `rayfin up`, store the lakehouse Files URL as a Rayfin secret:
  `echo https://onelake.dfs.fabric.microsoft.com/<ws>/<lh>.Lakehouse/Files | npx rayfin secret set ONELAKE_FILES_URL --stdin`

Everything else is Rayfin — see the [Rayfin documentation](https://learn.microsoft.com/fabric/embedded/rayfin/overview) for full details:

```bash
rayfin login      # sign in to Fabric
rayfin up         # build + deploy to Fabric static hosting; prints the hosting URL
```

Then run the **Import Data** workflow to fill the lakehouse, and open the app inside the Fabric
portal or in its own tab.
