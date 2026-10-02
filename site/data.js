// =============================================================================
// data.js — DataSource: bring up DuckDB-WASM with `db` attached
// =============================================================================
// Given the AuthProvider (auth.js), it:
//   1. instantiates DuckDB-WASM,
//   2. resolves the latest .duckdb file from the OneLake `latest.txt` pointer,
//   3. ATTACHes that OneLake file in place over HTTP (READ_ONLY, schema `db`) — DuckDB reads only
//      the blocks a query touches (Range requests); nothing is downloaded up front.
// Both reads go to the OneLake data/ folder with a read-only SAS from the getDataSas function.
//
// The file is attached ONCE, by a URL without the SAS. A shim in the DuckDB worker appends the
// current SAS to every request; the page renews the SAS ~10 min before it expires and pushes it to
// the worker, so the hourly rotation never touches the attached database. A read that still fails
// (403 after sleep/wake, or the "Corrupt database file" it leaves behind in duckdb-wasm's read-ahead
// cache) is recovered by one DETACH/ATTACH under a new file name, then retried (app.js queryDb).
//
// Contract: after init(), schema `db` exists with
//   fct_summary(date,time,DUID,mw,price,cutoff), dim_duid(...), dim_calendar(...).
//
// DOM-free: progress is reported through the injected `onStatus` callback.
// =============================================================================

import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/+esm";
import { perf, HTTP_TRACE_SHIM } from "./perflog.js";

const SAS_CHANNEL = 'duckdb-sas';
const RENEW_AHEAD_MS = 10 * 60 * 1000;   // renew this long before the SAS expires (covers background-tab timer throttling)

// Prepended to the DuckDB worker (before the trace shim and importScripts): every request under
// DIR gets the current SAS appended. The first SAS is inlined so ATTACH cannot race a message;
// renewals arrive on the BroadcastChannel.
const sasShim = (dir, sas) => `(() => {
  const DIR = ${JSON.stringify(dir)};
  let sas = ${JSON.stringify(sas)};
  try { new BroadcastChannel(${JSON.stringify(SAS_CHANNEL)}).onmessage = ({ data }) => { sas = data; }; } catch (e) {}
  const sign = (u) => (typeof u === 'string' && u.startsWith(DIR)) ? u + (u.includes('?') ? '&' : '?') + sas : u;
  const X = self.XMLHttpRequest;
  if (X) self.XMLHttpRequest = class extends X { open(m, u, ...r) { return super.open(m, sign(u), ...r); } };
  const F = self.fetch;
  if (F) self.fetch = (input, init) => F(typeof input === 'string' ? sign(input) : input, init);
})();`;

export function createDataSource(auth, { onStatus = () => {} } = {}) {
  // Resolve the moving `latest.txt` pointer to a concrete db filename.
  async function resolveLatestDuckDB() {
    // no-store: latest.txt is a moving pointer; a cached copy would resolve to a stale db
    // filename and the dashboard would never pick up a fresh import.
    const fetchLatest = async () => {
      const { baseUrl: dir, sas } = await auth.dataAccess();
      const t = performance.now();
      const r = await fetch(`${dir}/latest.txt?${sas}`, { cache: 'no-store' });
      perf.log('fetch', 'GET latest.txt', { ms: performance.now() - t, status: r.status });
      return r;
    };
    let resp = await fetchLatest();
    if (resp.status === 403) { await renew(); resp = await fetchLatest(); }   // expired SAS
    if (!resp.ok) throw new Error(`Failed to read data/latest.txt: HTTP ${resp.status}`);
    const fname = (await resp.text()).trim();
    if (!fname) throw new Error('data/latest.txt is empty');
    console.log(`[data] latest db: ${fname}`);
    return fname;
  }

  // --- SAS renewal: sign a new one and push it to the worker ---
  const sasChannel = new BroadcastChannel(SAS_CHANNEL);
  let _renewTimer = null;

  function scheduleRenew(expiresOn) {
    clearTimeout(_renewTimer);
    _renewTimer = setTimeout(() => renew().catch(e => console.error('[data] SAS renewal failed', e)),
                             Math.max(Date.parse(expiresOn) - Date.now() - RENEW_AHEAD_MS, 0));
  }

  async function renew() {
    await auth.refresh();
    const { sas, expiresOn } = await auth.dataAccess();
    sasChannel.postMessage(sas);
    scheduleRenew(expiresOn);
  }

  // --- Attach ---
  let _remote = null;        // { db, conn, dir, file, name, n }
  let _recovering = null;

  async function attachRemote(db, conn, dir, file, n = 0) {
    const name = `r${n}_${file}`;
    // A distinct URL per registration (duckdb-wasm also indexes files by URL); the shim adds the SAS.
    const url = n ? `${dir}/${file}?v=${n}` : `${dir}/${file}`;
    await db.registerFileURL(name, url, duckdb.DuckDBDataProtocol.HTTP, false);
    await perf.time('attach', `ATTACH ${file}`, () => conn.query(`ATTACH '${name}' AS db (READ_ONLY);`));
    const old = _remote?.name;
    _remote = { db, conn, dir, file, name, n };
    if (old) await db.dropFile(old).catch(() => {});
  }

  // Fallback after a failed read: fresh SAS, then re-attach under a NEW file name. The new name
  // gives duckdb-wasm a new file id, which orphans the read-ahead window the failed read poisoned
  // (that window is what yields "Corrupt database file ... stored checksum 0" on the next reads).
  // Concurrent callers share one recovery.
  function recover() {
    if (!_remote) return Promise.resolve();
    _recovering ??= (async () => {
      const { db, conn, dir, file, n } = _remote;
      await renew();
      await perf.time('attach', 'DETACH (recover after failed read)', () => conn.query('DETACH db;'));
      await attachRemote(db, conn, dir, file, n + 1);
    })().finally(() => { _recovering = null; });
    return _recovering;
  }

  async function init() {
    onStatus("Loading DuckDB WASM...");
    // The worker shim needs the data dir + a SAS before the bundle loads.
    const { baseUrl: dir, sas, expiresOn } = await auth.dataAccess();
    scheduleRenew(expiresOn);

    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
    const workerUrl = URL.createObjectURL(
      // sasShim signs every data request; HTTP_TRACE_SHIM (on top) times them for the Logs tab.
      new Blob([sasShim(dir, sas), '\n', HTTP_TRACE_SHIM, `\nimportScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    // duckdb-wasm defaults forceFullHTTPReads to TRUE: an HTTP file is then GET'd whole (1.3 GB)
    // instead of Range-read. Turn it off so remote ATTACH only reads the blocks it touches.
    await db.open({ filesystem: { forceFullHTTPReads: false } });

    const conn = await db.connect();
    // OneLake answers `HEAD` + Range with 200 (not 206). With reliable_head_requests on (default),
    // the Range probe never learns the file size and falls back to a full GET; off, it takes the
    // size from the HEAD Content-Length and uses Range reads.
    await conn.query("SET reliable_head_requests = false;");

    // No fallback: if OneLake is unreachable the dashboard must say so.
    const dbFile = await resolveLatestDuckDB();
    onStatus("Opening database...");
    await attachRemote(db, conn, dir, dbFile);
    console.log(`[data] ${dbFile}: attached remotely (HTTP range reads)`);
    await conn.query("SET preserve_insertion_order = false;");

    return { db, conn };
  }

  return { init, recover };
}
