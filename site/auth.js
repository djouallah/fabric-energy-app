// =============================================================================
// auth.js — AuthProvider abstraction (presentation/data agnostic)
// =============================================================================
// One interface, two implementations selected by config:
//   'rayfin' -> Rayfin Fabric SSO + the getStorageToken function, bearer token for OneLake (default)
//   'none'   -> no auth at all (plain static hosting, same-origin/public data)
//
// DOM-free: progress is reported through the injected `onStatus` callback so this
// module never touches the page. The dashboard (app.js) owns all UI, including the
// sign-in gate — it just calls ensureSession()/getHeaders() here.
//
//   const auth = createAuth(cfg, { onStatus });
//   if (await auth.ensureSession(false)) { /* have what we need to fetch data */ }
//   fetch(url, { headers: auth.getHeaders() });
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

// --- Rayfin provider: Fabric SSO session, then the getStorageToken function (rayfin/functions)
// returns a OneLake bearer token issued to the app identity. No second login, and the session is
// handed over by postMessage, so it works inside the Fabric portal iframe. Backend URL, key and
// Fabric coordinates come from the rayfin.config.json that `rayfin up` writes next to the site.
function createRayfinAuth() {
  const REFRESH_MARGIN_MS = 5 * 60 * 1000;   // refetch the storage token this long before expiry
  let _client = null;
  let _fabric = null;
  let _fabricOpts = null;
  let _token = null;
  let _exp = 0;
  let _timer = null;

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

  // JWT `exp` (seconds) -> ms; 0 if unreadable, which just means "refetch on the next 401".
  function jwtExpiry(token) {
    try {
      const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(b64)).exp * 1000 || 0;
    } catch (e) { return 0; }
  }

  async function fetchToken() {
    const { token } = await _client.functions.getStorageToken.invoke();
    _token = token;
    _exp = jwtExpiry(token);
    // Refresh ahead of expiry so long-lived tabs (and query-log writes) don't hit a 401 first.
    clearTimeout(_timer);
    if (_exp) _timer = setTimeout(() => fetchToken().catch(e => console.warn('[auth] token refresh failed:', e)),
                                  Math.max(_exp - Date.now() - REFRESH_MARGIN_MS, 60 * 1000));
  }

  // Silent: stored session / refresh token / Fabric iframe handoff. Interactive (button click)
  // adds the Fabric popup for a standalone tab.
  async function acquire(interactive) {
    await init();
    if (_token && (!_exp || Date.now() < _exp - REFRESH_MARGIN_MS)) return true;
    if (!_client.auth.getSession()?.isAuthenticated) {
      const session = interactive
        ? await _fabric.ensureSignedInWithFabric(_client.auth, _fabricOpts)
        : await _fabric.initEmbeddedAuth(_client.auth, _fabricOpts);
      if (!session?.isAuthenticated) return false;
    }
    await fetchToken();
    return true;
  }

  return {
    mode: 'rayfin',
    ensureSession(interactive) { return acquire(interactive); },
    getHeaders() { return _token ? { Authorization: 'Bearer ' + _token } : {}; },
    getUserId() {
      const u = _client && _client.auth.getSession()?.user;
      return (u && (u.email || u.id)) || null;
    },
    async refresh() {
      _token = null;
      try { return await acquire(false); } catch (e) { return false; }
    },
    _clearToken() { _token = null; },
  };
}

// Pick the provider: 'none' for plain static hosting, otherwise Rayfin.
export function createAuth(cfg = {}) {
  return cfg.auth === 'none' ? createNoAuth() : createRayfinAuth();
}
