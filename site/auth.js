// =============================================================================
// auth.js — AuthProvider abstraction (presentation/data agnostic)
// =============================================================================
// One interface, two implementations selected by config:
//   'rayfin' -> Rayfin Fabric SSO + a function that returns a scoped OneLake SAS (default)
//   'none'   -> no auth at all (plain static hosting, same-origin/public data)
//
// DOM-free: the dashboard (app.js) owns all UI, including the sign-in gate.
//
//   const auth = createAuth(cfg);
//   if (await auth.ensureSession(false)) { /* signed in */ }
//   auth.dataAccess?.()  -> { baseUrl, sas }   (rayfin only; data.js uses it when present)
// =============================================================================

// Keep these on the same version: jsDelivr resolves their shared deps (rayfin-auth, rayfin-lib)
// to the same module URLs, so the provider operates on the client's own Auth instance.
import { perf } from './perflog.js';

const RAYFIN_CLIENT_ESM = "https://cdn.jsdelivr.net/npm/@microsoft/rayfin-client@1.36.1/+esm";
const RAYFIN_FABRIC_ESM = "https://cdn.jsdelivr.net/npm/@microsoft/rayfin-auth-provider-fabric@1.36.1/+esm";

// --- No-auth provider: everything is already accessible. ---
function createNoAuth() {
  return {
    mode: 'none',
    async ensureSession() { return true; },
    getHeaders() { return {}; },
    async refresh() { return true; },
  };
}

// --- Rayfin provider: Fabric SSO session (no second login; inside the Fabric portal iframe the
// session is handed over by postMessage). The browser never holds a storage token: the getDataSas function (rayfin/functions)
// signs a read-only OneLake SAS on the data/ folder, valid ~55 min and cached in localStorage
// across reloads, so a visitor calls the function about once an hour. Backend URL, key and Fabric coordinates come
// from the rayfin.config.json that `rayfin up` writes next to the site.
function createRayfinAuth() {
  const RENEW_MARGIN_MS = 30 * 1000;       // re-sign this long before a SAS expires
  const DATA_SAS_KEY = 'rayfin_data_sas';
  let _client = null;
  let _fabric = null;
  let _fabricOpts = null;
  let _data = load();                      // { baseUrl, sas, expiresOn } from getDataSas

  // localStorage can be unavailable (private mode, blocked storage): the cache is best-effort.
  function load() { try { return JSON.parse(localStorage.getItem(DATA_SAS_KEY)); } catch (e) { return null; } }
  function save(v) { try { v ? localStorage.setItem(DATA_SAS_KEY, JSON.stringify(v)) : localStorage.removeItem(DATA_SAS_KEY); } catch (e) {} }
  const fresh = (signed) => !!signed && Date.now() < Date.parse(signed.expiresOn) - RENEW_MARGIN_MS;

  async function init() {
    if (_client) return;
    const [{ RayfinClient, resolveRayfinConfig }, fabric] =
      await Promise.all([import(RAYFIN_CLIENT_ESM), import(RAYFIN_FABRIC_ESM)]);
    const resolved = await resolveRayfinConfig({});
    if (!resolved.baseUrl) throw new Error('rayfin.config.json not found — deploy with `rayfin up`');
    _client = new RayfinClient({ ...resolved, authStorage: true });
    const rc = _client.runtimeConfig || {};
    _fabricOpts = {
      workspaceId: rc.workspaceId,
      projectId: rc.itemId,
      fabricPortalUrl: rc.portalUrl,
      returnOrigin: window.location.origin,
    };
    _fabric = fabric;
  }

  async function dataAccess() {
    if (fresh(_data)) return _data;
    await init();
    _data = await perf.time('sas', 'getDataSas (function call)', () => _client.functions.getDataSas.invoke());
    // How long the new SAS lives (capped by the function's storage-token expiry) — a short one
    // means frequent re-attaches.
    perf.log('info', `SAS valid ${((Date.parse(_data.expiresOn) - Date.now()) / 60000).toFixed(1)} min (expires ${_data.expiresOn})`);
    save(_data);
    return _data;
  }

  // Silent: cached data SAS / stored session / refresh token / Fabric iframe handoff.
  // Interactive (button click) adds the Fabric popup for a standalone tab.
  async function ensureSession(interactive) {
    if (!interactive && fresh(_data)) return true;
    await init();
    if (_client.auth.getSession()?.isAuthenticated) return true;
    if (interactive) return !!(await _fabric.ensureSignedInWithFabric(_client.auth, _fabricOpts))?.isAuthenticated;
    return !!(await _fabric.initEmbeddedAuth(_client.auth, _fabricOpts))?.isAuthenticated;
  }

  return {
    mode: 'rayfin',
    ensureSession,
    getHeaders() { return {}; },
    dataAccess,
    // Drop cached SAS (e.g. after a 403) so the next call re-signs.
    async refresh() {
      _data = null;
      save(null);
      return true;
    },
  };
}

// Pick the provider: 'none' for plain static hosting, otherwise Rayfin.
export function createAuth(cfg = {}) {
  return cfg.auth === 'none' ? createNoAuth() : createRayfinAuth();
}
