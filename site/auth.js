// =============================================================================
// auth.js — AuthProvider abstraction (presentation/data agnostic)
// =============================================================================
// One interface, two implementations selected by config:
//   'rayfin' -> Rayfin Fabric SSO + functions that return single-file OneLake SAS URLs (default)
//   'none'   -> no auth at all (plain static hosting, same-origin/public data)
//
// DOM-free: the dashboard (app.js) owns all UI, including the sign-in gate.
//
//   const auth = createAuth(cfg);
//   if (await auth.ensureSession(false)) { /* signed in */ }
//   auth.signedDataUrl?.()  -> { file, url }   (rayfin only; data.js uses it when present)
//   auth.signedUploadUrl?.(relPath) -> url
// =============================================================================

// Keep these on the same version: jsDelivr resolves their shared deps (rayfin-auth, rayfin-lib)
// to the same module URLs, so the provider operates on the client's own Auth instance.
const RAYFIN_CLIENT_ESM = "https://cdn.jsdelivr.net/npm/@microsoft/rayfin-client@1.36.1/+esm";
const RAYFIN_FABRIC_ESM = "https://cdn.jsdelivr.net/npm/@microsoft/rayfin-auth-provider-fabric@1.36.1/+esm";

// --- No-auth provider: everything is already accessible. ---
function createNoAuth() {
  return {
    mode: 'none',
    async ensureSession() { return true; },
    getHeaders() { return {}; },
    getUserId() { return 'anonymous'; },
    async refresh() { return true; },
  };
}

// --- Rayfin provider: Fabric SSO session (no second login; inside the Fabric portal iframe the
// session is handed over by postMessage). The browser never holds a storage token: the getDataUrl /
// getLogUploadUrl functions (rayfin/functions) sign OneLake SAS URLs for one file each, read-only
// for the database, create/write for a query-log CSV, ~15 min. Backend URL, key and Fabric
// coordinates come from the rayfin.config.json that `rayfin up` writes next to the site.
function createRayfinAuth() {
  const RENEW_MARGIN_MS = 2 * 60 * 1000;   // re-sign this long before a SAS expires
  let _client = null;
  let _fabric = null;
  let _fabricOpts = null;
  let _data = null;                        // cached { file, url, expiresOn } from getDataUrl

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

  // Silent: stored session / refresh token / Fabric iframe handoff. Interactive (button click)
  // adds the Fabric popup for a standalone tab.
  async function ensureSession(interactive) {
    await init();
    if (_client.auth.getSession()?.isAuthenticated) return true;
    const session = interactive
      ? await _fabric.ensureSignedInWithFabric(_client.auth, _fabricOpts)
      : await _fabric.initEmbeddedAuth(_client.auth, _fabricOpts);
    return !!session?.isAuthenticated;
  }

  const fresh = (signed) => signed && Date.now() < Date.parse(signed.expiresOn) - RENEW_MARGIN_MS;

  return {
    mode: 'rayfin',
    ensureSession,
    getHeaders() { return {}; },
    getUserId() {
      const u = _client && _client.auth.getSession()?.user;
      return (u && (u.email || u.id)) || null;
    },
    async signedDataUrl() {
      if (!fresh(_data)) _data = await _client.functions.getDataUrl.invoke();
      return _data;
    },
    async signedUploadUrl(relPath) {
      const m = String(relPath).match(/^query_logs\/data\/([^/]+)$/);
      if (!m) throw new Error(`no signed upload for ${relPath}`);
      return (await _client.functions.getLogUploadUrl.invoke({ name: m[1] })).url;
    },
    // Drop cached SAS URLs (e.g. after a 403) so the next call re-signs.
    async refresh() {
      _data = null;
      try { return await ensureSession(false); } catch (e) { return false; }
    },
  };
}

// Pick the provider: 'none' for plain static hosting, otherwise Rayfin.
export function createAuth(cfg = {}) {
  return cfg.auth === 'none' ? createNoAuth() : createRayfinAuth();
}
