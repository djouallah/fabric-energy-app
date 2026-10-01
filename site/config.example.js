// Copy this file to `config.js` (same folder) and fill in your own values.
// config.js is gitignored, so your tenant/workspace identifiers stay out of the repo.
//
// This config selects the AUTH and DATA layers at runtime (see auth.js / data.js), so the same
// dashboard can be published to different platforms by shipping a different config.js.
// For a no-auth static deploy (GitHub Pages, S3, bundled data) start from config.static.example.js.
window.RAYFIN_WASM_CONFIG = {
  // 'rayfin' (default) = Rayfin Fabric SSO; functions (rayfin/functions) return single-file OneLake
  //   SAS URLs. No extra login, works in the Fabric iframe. Needs no ids or data URL here: ids come
  //   from rayfin.config.json (`rayfin up`), the lakehouse URL from the ONELAKE_FILES_URL secret.
  // 'none' = no auth (public/same-origin data).
  auth: "rayfin",

  // auth 'none' only (rayfin ignores it): base URL the database is read from as
  // <dataBaseUrl>/data/<latest>.duckdb. "" = same-origin ./data/data.duckdb.
  // (Legacy alias `oneLakeBase` is still accepted if `dataBaseUrl` is absent.)
  dataBaseUrl: "",
};
