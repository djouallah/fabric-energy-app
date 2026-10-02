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
// Contract: after init(), schema `db` exists with
//   fct_summary(date,time,DUID,mw,price,cutoff), dim_duid(...), dim_calendar(...).
//
// DOM-free: progress is reported through the injected `onStatus` callback.
// =============================================================================

import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/+esm";
import { perf, HTTP_TRACE_SHIM } from "./perflog.js";

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
    if (resp.status === 403) { await auth.refresh(); resp = await fetchLatest(); }   // expired SAS
    if (!resp.ok) throw new Error(`Failed to read data/latest.txt: HTTP ${resp.status}`);
    const fname = (await resp.text()).trim();
    if (!fname) throw new Error('data/latest.txt is empty');
    console.log(`[data] latest db: ${fname}`);
    return fname;
  }

  // Free the full .duckdb copies that earlier (download-to-OPFS) versions left in this browser.
  async function evictOPFSCopies() {
    try {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) {
        if (/^data.*\.duckdb$/.test(name)) await root.removeEntry(name).catch(() => {});
      }
    } catch (e) { /* no OPFS: nothing to free */ }
  }

  // Attach once. The SAS (55 min) is part of the file URL; when a read fails with 403 the caller
  // forces one re-attach with a fresh SAS and retries (~1/hour).
  let _remote = null;        // { db, conn, file, name, n }
  let _reattaching = null;

  async function attachRemote(db, conn, file, n = 0) {
    const { baseUrl: dir, sas } = await auth.dataAccess();
    const name = `r${n}_${file}`;
    await db.registerFileURL(name, `${dir}/${file}?${sas}`, duckdb.DuckDBDataProtocol.HTTP, false);
    await perf.time('attach', `ATTACH ${file}`, () => conn.query(`ATTACH '${name}' AS db (READ_ONLY);`));
    const old = _remote?.name;
    _remote = { db, conn, file, name, n };
    if (old) await db.dropFile(old).catch(() => {});
  }

  // Re-attach with a fresh SAS — only after a failed read (403). No proactive re-attach: swapping
  // the file under in-flight queries made their reads return zeros ("Corrupt database file").
  // Concurrent callers share one re-attach.
  function ensureFresh(force = false) {
    if (!_remote || !force) return Promise.resolve();
    _reattaching ??= (async () => {
      const { db, conn, file, n } = _remote;
      await auth.refresh();
      await perf.time('attach', 'DETACH (re-attach with fresh SAS)', () => conn.query('DETACH db;'));
      await attachRemote(db, conn, file, n + 1);
    })().finally(() => { _reattaching = null; });
    return _reattaching;
  }

  async function init() {
    onStatus("Loading DuckDB WASM...");
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
    const workerUrl = URL.createObjectURL(
      // HTTP_TRACE_SHIM: times every HTTP request DuckDB makes (seeks) for the Logs tab.
      new Blob([HTTP_TRACE_SHIM, `\nimportScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
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
    await attachRemote(db, conn, dbFile);
    await evictOPFSCopies();
    console.log(`[data] ${dbFile}: attached remotely (HTTP range reads)`);
    await conn.query("SET preserve_insertion_order = false;");

    return { db, conn };
  }

  return { init, ensureFresh };
}
