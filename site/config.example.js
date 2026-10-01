// Copy this file to `config.js` (same folder) and fill in your own values.
// config.js is gitignored, so your tenant/workspace identifiers stay out of the repo.
//
// This config selects the AUTH and DATA layers at runtime (see auth.js / data.js), so the same
// dashboard can be published to different platforms by shipping a different config.js.
// For a no-auth static deploy (GitHub Pages, S3, bundled data) start from config.static.example.js.
window.RAYFIN_WASM_CONFIG = {
  // 'rayfin' (default) = Rayfin Fabric SSO; the getStorageToken function (rayfin/functions) returns
  //   the OneLake bearer token as the app identity. No extra login, works in the Fabric iframe.
  //   Needs no ids here — they come from the rayfin.config.json written by `rayfin up`.
  // 'none' = no auth (public/same-origin data).
  auth: "rayfin",

  // Base URL where the data lives, of the form:
  //   https://onelake.dfs.fabric.microsoft.com/<workspace>/<lakehouse>.Lakehouse/Files
  // The dashboard reads the database from <dataBaseUrl>/data/<latest>.duckdb (with the bearer token).
  // Set to "" to instead serve a same-origin ./data/data.duckdb (no auth needed).
  // (Legacy alias `oneLakeBase` is still accepted if `dataBaseUrl` is absent.)
  dataBaseUrl: "https://onelake.dfs.fabric.microsoft.com/<workspace>/<lakehouse>.Lakehouse/Files",
};
