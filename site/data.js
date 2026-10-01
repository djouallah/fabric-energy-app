// =============================================================================
// data.js — DataSource: bring up DuckDB-WASM with `db` attached
// =============================================================================
// Platform-agnostic data loading. Given an AuthProvider (auth.js) and config, it:
//   1. instantiates DuckDB-WASM,
//   2. resolves the latest .duckdb file (OneLake `latest.txt` pointer, if any),
//   3. rayfin: ATTACHes the OneLake file in place over HTTP — DuckDB reads only the blocks a query
//      touches (Range requests); nothing is downloaded up front.
//      otherwise: fetches + OPFS-caches it (conditional GET via ETag) and ATTACHes the local copy.
//   The attachment is always schema `db` (READ_ONLY).
//
// Where the file comes from:
//   auth.dataAccess present (rayfin) -> OneLake data/ folder + a read-only SAS from the backend.
//   else cfg.dataBaseUrl ?? cfg.oneLakeBase ?? '':
//     non-empty -> fetch `<base>/data/<file>.duckdb` with auth headers.
//     ''        -> same-origin `./data/data.duckdb`, no auth (bundled / public static host).
//
// Contract: after init(), schema `db` exists with
//   fct_summary(date,time,DUID,mw,price,cutoff), dim_duid(...), dim_calendar(...).
//
// DOM-free: progress is reported through the injected `onStatus` callback.
// =============================================================================

import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm";

export function createDataSource(cfg = {}, auth, { onStatus = () => {} } = {}) {
  const baseUrl = cfg.dataBaseUrl ?? cfg.oneLakeBase ?? '';
  const signed = typeof auth.dataAccess === 'function';
  const REATTACH_MARGIN_MS = 2 * 60 * 1000;   // re-attach with a fresh SAS this long before expiry
  // An expired/invalid token is a 401; an expired SAS is a 403.
  const authFailed = (resp) => resp.status === 401 || resp.status === 403;

  // Cache a remote .duckdb file in OPFS using the file's ETag for freshness.
  // OneLake honors conditional GETs, so on every load we send If-None-Match:
  //   304 -> file unchanged, use the OPFS copy (no download)
  //   200 -> file changed (or first load) -> download + store new ETag
  // => a plain refresh automatically picks up new data; no manual versioning.
  // `renewUrl` (optional) re-signs the URL after an auth failure; otherwise the same URL is retried
  // with refreshed auth headers.
  // source: 'opfs-hit' | 'opfs-miss' | 'opfs-refresh'
  async function cacheInOPFS(db, url, filename, renewUrl) {
    const root = await navigator.storage.getDirectory();
    const etagKey = `opfs_etag_${filename}`;
    const cachedEtag = localStorage.getItem(etagKey);

    const doFetch = (conditional) => {
      const headers = auth.getHeaders();
      if (conditional && cachedEtag) headers['If-None-Match'] = cachedEtag;
      return fetch(url, { headers });
    };

    const renew = async () => { await auth.refresh(); if (renewUrl) url = await renewUrl(); };

    onStatus("Checking for updates...");
    let resp = await doFetch(true);
    if (authFailed(resp)) { await renew(); resp = await doFetch(true); }

    // Unchanged -> reuse the OPFS copy.
    if (resp.status === 304) {
      try {
        const handle = await root.getFileHandle(filename);
        const file = await handle.getFile();
        console.log(`[OPFS] ${filename} unchanged (304), using cache (${(file.size/1048576).toFixed(1)} MB)`);
        await db.registerFileBuffer(filename, new Uint8Array(await file.arrayBuffer()));
        return { source: 'opfs-hit' };
      } catch (e) {
        console.log(`[OPFS] 304 but no OPFS copy for ${filename}, re-downloading`);
        resp = await doFetch(false); // unconditional
        if (authFailed(resp)) { await renew(); resp = await doFetch(false); }
      }
    }

    if (!resp.ok) throw new Error(`Failed to fetch ${filename}: HTTP ${resp.status}`);
    onStatus("Downloading database...");
    const buffer = new Uint8Array(await resp.arrayBuffer());
    if (buffer.byteLength < 100) throw new Error(`${filename} is too small (${buffer.byteLength} bytes), likely not a valid database`);
    const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(1);

    const handle = await root.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    await writable.write(buffer);
    await writable.close();
    const newEtag = resp.headers.get('ETag');
    if (newEtag) localStorage.setItem(etagKey, newEtag); else localStorage.removeItem(etagKey);
    console.log(`[OPFS] Downloaded ${filename} (${sizeMB} MB)`);

    await db.registerFileBuffer(filename, buffer);
    return { source: cachedEtag ? 'opfs-refresh' : 'opfs-miss' };
  }

  // URL of a file in the data folder: SAS-signed (rayfin) or `<baseUrl>/data/<name>` + auth headers.
  async function dataUrl(name) {
    if (!signed) return `${baseUrl}/data/${name}`;
    const { baseUrl: dir, sas } = await auth.dataAccess();
    return `${dir}/${name}?${sas}`;
  }

  // Resolve the moving `latest.txt` pointer to a concrete db filename. Same-origin
  // (no baseUrl) has no pointer — always 'data.duckdb'.
  async function resolveLatestDuckDB() {
    if (!signed && !baseUrl) return 'data.duckdb';
    try {
      // no-store: latest.txt is a moving pointer; a cached copy would resolve to a stale db
      // filename and the dashboard would never pick up a fresh import.
      const fetchLatest = async () => fetch(await dataUrl('latest.txt'), { headers: auth.getHeaders(), cache: 'no-store' });
      let resp = await fetchLatest();
      if (authFailed(resp)) { await auth.refresh(); resp = await fetchLatest(); }
      if (!resp.ok) return 'data.duckdb';
      const fname = (await resp.text()).trim();
      console.log(`[data] latest db: ${fname}`);
      return fname || 'data.duckdb';
    } catch (e) {
      console.warn('[data] latest.txt read failed:', e.message);
      return 'data.duckdb';
    }
  }

  async function evictOldDuckDBs(keep) {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of root.entries()) {
      if (/^data.*\.duckdb$/.test(name) && name !== keep) {
        await root.removeEntry(name).catch(() => {});
      }
    }
  }

  // Remote attach (rayfin): the SAS is part of the file URL, so before it expires the file is
  // re-registered under a new name with a fresh SAS and re-ATTACHed (metadata re-read, ~1/hour).
  let _remote = null;        // { db, conn, file, name, n, expiresAt }
  let _reattaching = null;

  async function attachRemote(db, conn, file, n = 0) {
    const { baseUrl: dir, sas, expiresOn } = await auth.dataAccess();
    const name = `r${n}_${file}`;
    await db.registerFileURL(name, `${dir}/${file}?${sas}`, duckdb.DuckDBDataProtocol.HTTP, false);
    await conn.query(`ATTACH '${name}' AS db (READ_ONLY);`);
    const old = _remote?.name;
    _remote = { db, conn, file, name, n, expiresAt: Date.parse(expiresOn) };
    if (old) await db.dropFile(old).catch(() => {});
  }

  // Re-attach with a fresh SAS. `force` after a failed read (e.g. 403); otherwise only when the
  // current SAS is about to expire. Concurrent callers share one re-attach.
  function ensureFresh(force = false) {
    if (!_remote || (!force && Date.now() < _remote.expiresAt - REATTACH_MARGIN_MS)) return Promise.resolve();
    _reattaching ??= (async () => {
      const { db, conn, file, n } = _remote;
      if (force) await auth.refresh();
      await conn.query('DETACH db;');
      await attachRemote(db, conn, file, n + 1);
    })().finally(() => { _reattaching = null; });
    return _reattaching;
  }

  async function init() {
    onStatus("Loading DuckDB WASM...");
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);

    const conn = await db.connect();

    // No fallback to a bundled copy: if OneLake is unreachable the dashboard must say so, not
    // silently show stale demo data.
    const dbFile = await resolveLatestDuckDB();
    if (signed) {
      onStatus("Opening database...");
      await attachRemote(db, conn, dbFile);
      await evictOldDuckDBs(null);   // free the full copies earlier versions kept in OPFS
      console.log(`[data] ${dbFile}: attached remotely (HTTP range reads)`);
    } else {
      const url = baseUrl ? await dataUrl(dbFile) : './data/data.duckdb';
      const dbResult = await cacheInOPFS(db, url, dbFile);
      await evictOldDuckDBs(dbFile);
      await conn.query(`ATTACH '${dbFile}' AS db (READ_ONLY);`);
      const sourceLabel = { 'opfs-hit': 'cached', 'opfs-miss': 'downloaded', 'opfs-refresh': 'refreshed' };
      console.log(`[OPFS] ${dbFile}: ${sourceLabel[dbResult.source]}`);
    }
    await conn.query("SET preserve_insertion_order = false;");
    console.log(`[DuckDB] crossOriginIsolated: ${window.crossOriginIsolated} (${window.crossOriginIsolated ? 'multi-threaded' : 'single-threaded'})`);

    return { db, conn };
  }

  return { init, ensureFresh };
}
